import {
  apiError,
  fetchIrodori,
  getErrorMessage,
  getIrodoriErrorDetail,
} from "../_lib/irodori";
import { getScopedIrodoriHeaders, getVoiceOwnerId } from "../_lib/voice-owner";
import { voiceServerlessEnabled, serviceResponse, listVoiceAssets, removeVoiceAsset } from "../_lib/service-serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ASSET_ID_PATTERN = /^vasset_[a-f0-9]{32}$/;

export async function GET() {
  if (voiceServerlessEnabled()) return serviceResponse(async () => Response.json({ object: "list", data: await listVoiceAssets(await getVoiceOwnerId()) },
    { headers: { "Cache-Control": "private, no-store" } }));
  try {
    const response = await fetchIrodori(
      "/v1/audio/speaker-assets",
      { method: "GET", headers: await getScopedIrodoriHeaders() },
    );
    if (!response.ok) {
      return apiError(
        "マイボイス一覧を取得できませんでした。",
        response.status,
        process.env.NODE_ENV === "development"
          ? await getIrodoriErrorDetail(response)
          : undefined,
      );
    }
    return new Response(response.body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return apiError(
      "Irodori-TTSサーバーに接続できません。",
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
    const body = await request.json() as { voiceAssetId?: unknown };
    voiceAssetId = typeof body.voiceAssetId === "string" ? body.voiceAssetId : "";
  } catch {
    return apiError("削除するボイスモデルIDが必要です。", 400);
  }
  if (!ASSET_ID_PATTERN.test(voiceAssetId)) {
    return apiError("ボイスモデルIDが正しくありません。", 400);
  }

  if (voiceServerlessEnabled()) return serviceResponse(async () => removeVoiceAsset(await getVoiceOwnerId(), voiceAssetId));

  try {
    const response = await fetchIrodori(
      `/v1/audio/voice-assets/${encodeURIComponent(voiceAssetId)}`,
      { method: "DELETE", headers: await getScopedIrodoriHeaders() },
    );
    if (!response.ok && response.status !== 404) {
      return apiError(
        "ボイスモデルの削除に失敗しました。もう一度お試しください。",
        response.status,
        process.env.NODE_ENV === "development"
          ? await getIrodoriErrorDetail(response)
          : undefined,
      );
    }
    return Response.json(
      { deleted: true, voiceAssetId },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(
      "音声サーバーに接続できず、ボイスモデルを削除できませんでした。もう一度お試しください。",
      503,
      process.env.NODE_ENV === "development" ? getErrorMessage(error) : undefined,
    );
  }
}
