import {
  apiError,
  fetchIrodori,
  getErrorMessage,
  getIrodoriErrorDetail,
} from "../../_lib/irodori";
import { getScopedIrodoriHeaders } from "../../_lib/voice-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JOB_ID_PATTERN = /^spi_[a-f0-9]{32}$/;

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

async function proxyJob(method: "GET" | "DELETE", context: RouteContext) {
  const { jobId } = await context.params;

  if (!JOB_ID_PATTERN.test(jobId)) {
    return apiError("学習ジョブIDが正しくありません。", 400);
  }

  try {
    const response = await fetchIrodori(
      `/v1/audio/speaker-inversions/${jobId}`,
      { method, headers: await getScopedIrodoriHeaders() },
    );

    if (!response.ok) {
      return apiError(
        method === "DELETE"
          ? "Speaker Inversionを中止できませんでした。"
          : "Speaker Inversionの進捗を取得できませんでした。",
        response.status,
        process.env.NODE_ENV === "development"
          ? await getIrodoriErrorDetail(response)
          : undefined,
      );
    }

    return new Response(response.body, {
      status: response.status,
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

export function GET(_request: Request, context: RouteContext) {
  return proxyJob("GET", context);
}

export function DELETE(_request: Request, context: RouteContext) {
  return proxyJob("DELETE", context);
}
