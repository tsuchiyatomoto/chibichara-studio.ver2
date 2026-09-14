import {
  apiError,
  fetchIrodori,
  getErrorMessage,
  getIrodoriErrorDetail,
} from "../_lib/irodori";
import { getScopedIrodoriHeaders } from "../_lib/voice-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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
