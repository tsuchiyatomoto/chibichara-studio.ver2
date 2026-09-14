import {
  apiError,
  fetchIrodori,
  getErrorMessage,
  getIrodoriErrorDetail,
} from "../../../_lib/irodori";
import { getScopedIrodoriHeaders } from "../../../_lib/voice-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JOB_ID_PATTERN = /^spi_[a-f0-9]{32}$/;

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { jobId } = await context.params;

  if (!JOB_ID_PATTERN.test(jobId)) {
    return apiError("学習ジョブIDが正しくありません。", 400);
  }

  try {
    const response = await fetchIrodori(
      `/v1/audio/speaker-inversions/${jobId}/result`,
      { method: "GET", headers: await getScopedIrodoriHeaders() },
      60_000,
    );

    if (!response.ok || !response.body) {
      return apiError(
        "学習済みvoiceファイルを取得できませんでした。",
        response.status,
        process.env.NODE_ENV === "development"
          ? await getIrodoriErrorDetail(response)
          : undefined,
      );
    }

    return new Response(response.body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition":
          response.headers.get("content-disposition") ??
          'attachment; filename="voice.speaker.safetensors"',
        "Content-Type": "application/octet-stream",
      },
    });
  } catch (error) {
    return apiError(
      "Irodori-TTSサーバーからvoiceファイルを取得できませんでした。",
      503,
      process.env.NODE_ENV === "development"
        ? getErrorMessage(error)
        : undefined,
    );
  }
}
