import {
  apiError,
  fetchIrodori,
  getErrorMessage,
  getIrodoriErrorDetail,
} from "../_lib/irodori";
import { getScopedIrodoriHeaders } from "../_lib/voice-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = await request.formData();
    const voiceId = String(input.get("voice_id") ?? "").trim();
    const texts = String(input.get("texts") ?? "");
    const captions = String(input.get("captions") ?? "[]");
    const replace = String(input.get("replace") ?? "false");
    const files = input.getAll("files").filter(
      (value): value is File => value instanceof File,
    );

    if (!voiceId || voiceId.length > 80 || [...voiceId].some((char) => char < " ")) {
      return apiError(
        "Voice名は1〜80文字で指定してください。",
        400,
      );
    }

    if (files.length === 0) {
      return apiError("学習サンプルが必要です。", 400);
    }

    const upstreamBody = new FormData();
    upstreamBody.append("voice_id", voiceId);
    upstreamBody.append("texts", texts);
    upstreamBody.append("captions", captions);
    upstreamBody.append("replace", replace);
    files.forEach((file, index) => {
      upstreamBody.append("files", file, `sample-${index + 1}.wav`);
    });
    const response = await fetchIrodori(
      "/v1/audio/speaker-inversions",
      {
        method: "POST",
        headers: await getScopedIrodoriHeaders(),
        body: upstreamBody,
      },
      2 * 60_000,
    );

    if (!response.ok) {
      return apiError(
        "Speaker Inversionを開始できませんでした。",
        response.status,
        process.env.NODE_ENV === "development"
          ? await getIrodoriErrorDetail(response)
          : undefined,
      );
    }

    return new Response(response.body, {
      status: 202,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return apiError(
      "Irodori-TTSサーバーに学習データを送信できませんでした。",
      503,
      process.env.NODE_ENV === "development"
        ? getErrorMessage(error)
        : undefined,
    );
  }
}
