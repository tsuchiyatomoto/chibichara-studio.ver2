import { getVoiceOwnerId } from "../_lib/voice-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_IRODORI_TTS_BASE_URL = "http://127.0.0.1:8088";
const DEFAULT_IRODORI_TTS_MODEL = "irodori-tts";
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 5000;
const MAX_INPUT_LENGTH = 5000;
const MAX_CAPTION_LENGTH = 1000;

type GenerateSpeechRequest = {
  input?: unknown;
  caption?: unknown;
  speed?: unknown;
  voice?: unknown;
  voiceAssetId?: unknown;
};

function jsonError(message: string, status: number, detail?: string) {
  return Response.json(
    {
      error: message,
      ...(detail ? { detail } : {}),
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function getIrodoriBaseUrl() {
  return (
    process.env.IRODORI_TTS_BASE_URL ?? DEFAULT_IRODORI_TTS_BASE_URL
  ).replace(/\/+$/, "");
}

function getIrodoriModel() {
  return process.env.IRODORI_TTS_MODEL ?? DEFAULT_IRODORI_TTS_MODEL;
}

function getRequestTimeoutMs() {
  const configuredTimeout = Number(process.env.IRODORI_TTS_TIMEOUT_MS);

  if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  return Math.min(configuredTimeout, 30 * 60 * 1000);
}

function getUpstreamHeaders(includeJsonContentType = false) {
  const headers = new Headers();

  if (includeJsonContentType) {
    headers.set("Content-Type", "application/json");
  }

  if (process.env.IRODORI_TTS_API_KEY) {
    headers.set(
      "Authorization",
      `Bearer ${process.env.IRODORI_TTS_API_KEY}`,
    );
  }

  return headers;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function getUpstreamErrorDetail(response: Response) {
  const responseText = await response.text();

  if (!responseText) {
    return `${response.status} ${response.statusText}`.trim();
  }

  try {
    const data = JSON.parse(responseText) as {
      detail?: unknown;
      error?: unknown;
      message?: unknown;
    };
    const detail = data.detail ?? data.error ?? data.message;

    return typeof detail === "string" ? detail : responseText;
  } catch {
    return responseText;
  }
}

export async function GET() {
  try {
    const response = await fetchWithTimeout(
      `${getIrodoriBaseUrl()}/health`,
      {
        method: "GET",
        headers: getUpstreamHeaders(),
      },
      HEALTH_TIMEOUT_MS,
    );

    if (!response.ok) {
      return jsonError(
        "Irodori-TTSサーバーの接続確認に失敗しました。",
        503,
        process.env.NODE_ENV === "development"
          ? await getUpstreamErrorDetail(response)
          : undefined,
      );
    }

    const health = (await response.json()) as {
      speaker_inversion?: {
        ready?: boolean;
        reason?: string | null;
        min_samples?: number;
        max_samples?: number;
        max_steps?: number;
        busy?: boolean;
      };
    };

    return Response.json(
      {
        connected: true,
        model: getIrodoriModel(),
        speakerInversion: health.speaker_inversion ?? null,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return jsonError(
      "Irodori-TTSサーバーに接続できません。",
      503,
      process.env.NODE_ENV === "development"
        ? getErrorMessage(error)
        : undefined,
    );
  }
}

export async function POST(request: Request) {
  let body: GenerateSpeechRequest;

  try {
    body = (await request.json()) as GenerateSpeechRequest;
  } catch {
    return jsonError("JSON形式のリクエストを送信してください。", 400);
  }

  const input = typeof body.input === "string" ? body.input.trim() : "";
  const caption =
    typeof body.caption === "string" ? body.caption.trim() : "";
  const voice = typeof body.voice === "string" ? body.voice.trim() : "none";
  const voiceAssetId =
    typeof body.voiceAssetId === "string" ? body.voiceAssetId.trim() : "";
  const speed = typeof body.speed === "number" ? body.speed : 1;

  if (!input) {
    return jsonError("確認用の文章を入力してください。", 400);
  }

  if (input.length > MAX_INPUT_LENGTH) {
    return jsonError(
      `確認用の文章は${MAX_INPUT_LENGTH}文字以内にしてください。`,
      400,
    );
  }

  if (caption.length > MAX_CAPTION_LENGTH) {
    return jsonError(
      `声の指示は${MAX_CAPTION_LENGTH}文字以内にしてください。`,
      400,
    );
  }

  if (!voice || voice.length > 128) {
    return jsonError("参照ボイスIDが正しくありません。", 400);
  }

  if (voiceAssetId.length > 128) {
    return jsonError("VoiceアセットIDが正しくありません。", 400);
  }

  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    return jsonError("読み上げ速度は0.25〜4.0の範囲で指定してください。", 400);
  }

  try {
    const upstreamHeaders = getUpstreamHeaders(true);
    if (voiceAssetId) {
      upstreamHeaders.set("X-Irodori-Owner-ID", await getVoiceOwnerId());
    }
    const response = await fetchWithTimeout(
      `${getIrodoriBaseUrl()}/v1/audio/speech`,
      {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify({
          model: getIrodoriModel(),
          input,
          voice: voiceAssetId ? "none" : voice,
          ...(voiceAssetId ? { voice_asset_id: voiceAssetId } : {}),
          response_format: "wav",
          speed,
          ...(caption
            ? {
                irodori: {
                  caption,
                },
              }
            : {}),
        }),
      },
      getRequestTimeoutMs(),
    );

    if (!response.ok) {
      const detail = await getUpstreamErrorDetail(response);

      console.error("Irodori-TTS speech generation failed:", detail);

      return jsonError(
        "Irodori-TTSの音声生成に失敗しました。",
        response.status >= 400 && response.status < 600
          ? response.status
          : 502,
        process.env.NODE_ENV === "development" ? detail : undefined,
      );
    }

    if (!response.body) {
      return jsonError("Irodori-TTSから音声が返されませんでした。", 502);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'inline; filename="irodori-speech.wav"',
        "Content-Type": response.headers.get("content-type") ?? "audio/wav",
        "X-Irodori-Model": getIrodoriModel(),
      },
    });
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");

    console.error("Irodori-TTS request failed:", error);

    return jsonError(
      isTimeout
        ? "Irodori-TTSの音声生成がタイムアウトしました。"
        : "Irodori-TTSサーバーに接続できません。",
      isTimeout ? 504 : 503,
      process.env.NODE_ENV === "development"
        ? getErrorMessage(error)
        : undefined,
    );
  }
}
