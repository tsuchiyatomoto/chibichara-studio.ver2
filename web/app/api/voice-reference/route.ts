import {
  apiError,
  fetchIrodori,
  getErrorMessage,
  getIrodoriErrorDetail,
} from "../_lib/irodori";
import { getScopedIrodoriHeaders, getVoiceOwnerId } from "../_lib/voice-owner";
import { voiceServerlessEnabled, serviceResponse, createVoiceReference, removeVoiceAsset, readServiceForm } from "../_lib/service-serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
const ASSET_ID_PATTERN = /^vasset_[a-f0-9]{32}$/;

export async function POST(request: Request) {
  if (voiceServerlessEnabled()) return serviceResponse(async () => {
    const file = (await readServiceForm(request, 11 * 1024 ** 2)).get("file");
    if (!(file instanceof File)) return apiError("基準にする音声ファイルが必要です。", 400);
    return createVoiceReference(await getVoiceOwnerId(), file);
  });
  try {
    const input = await request.formData();
    const file = input.get("file");

    if (!(file instanceof File) || file.size === 0) {
      return apiError("基準にする音声ファイルが必要です。", 400);
    }

    if (file.size > MAX_REFERENCE_BYTES) {
      return apiError("基準音声は25MB以下にしてください。", 400);
    }

    const upstreamBody = new FormData();
    upstreamBody.append("file", file, "reference.wav");
    const response = await fetchIrodori(
      "/v1/audio/voice-assets/references",
      {
        method: "POST",
        headers: await getScopedIrodoriHeaders(),
        body: upstreamBody,
      },
      60_000,
    );

    if (!response.ok) {
      return apiError(
        "基準音声を一時保存できませんでした。",
        response.status,
        process.env.NODE_ENV === "development"
          ? await getIrodoriErrorDetail(response)
          : undefined,
      );
    }

    const data = (await response.json()) as { id?: unknown };
    if (typeof data.id !== "string") {
      return apiError("基準音声IDを取得できませんでした。", 502);
    }
    return Response.json(
      { voiceAssetId: data.id },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(
      "Irodori-TTSサーバーに基準音声を一時保存できませんでした。",
      503,
      process.env.NODE_ENV === "development"
        ? getErrorMessage(error)
        : undefined,
    );
  }
}

export async function DELETE(request: Request) {
  let voiceAssetId = "";

  try {
    const body = (await request.json()) as { voiceAssetId?: unknown };
    voiceAssetId =
      typeof body.voiceAssetId === "string" ? body.voiceAssetId : "";
  } catch {
    return apiError("削除する基準音声IDが必要です。", 400);
  }

  if (!ASSET_ID_PATTERN.test(voiceAssetId)) {
    return apiError("基準音声IDが正しくありません。", 400);
  }

  if (voiceServerlessEnabled()) return serviceResponse(async () => removeVoiceAsset(await getVoiceOwnerId(), voiceAssetId));

  try {
    const response = await fetchIrodori(
      `/v1/audio/voice-assets/${encodeURIComponent(voiceAssetId)}`,
      { method: "DELETE", headers: await getScopedIrodoriHeaders() },
    );

    if (!response.ok && response.status !== 404) {
      return apiError(
        "基準音声の削除に失敗しました。",
        response.status,
        process.env.NODE_ENV === "development"
          ? await getIrodoriErrorDetail(response)
          : undefined,
      );
    }

    return Response.json(
      { deleted: response.ok, voiceAssetId },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(
      "Irodori-TTSサーバーから基準音声を削除できませんでした。",
      503,
      process.env.NODE_ENV === "development"
        ? getErrorMessage(error)
        : undefined,
    );
  }
}
