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

export async function POST(request: Request, context: RouteContext) {
  const { jobId } = await context.params;
  if (!JOB_ID_PATTERN.test(jobId)) {
    return apiError("学習ジョブIDが正しくありません。", 400);
  }

  let name = "";
  try {
    const body = (await request.json()) as { name?: unknown };
    name = typeof body.name === "string" ? body.name.trim() : "";
  } catch {
    return apiError("保存名を指定してください。", 400);
  }

  if (!name || name.length > 80) {
    return apiError("保存名は1〜80文字で指定してください。", 400);
  }

  try {
    const body = new FormData();
    body.append("name", name);
    const response = await fetchIrodori(
      `/v1/audio/speaker-inversions/${jobId}/save`,
      {
        method: "POST",
        headers: await getScopedIrodoriHeaders(),
        body,
      },
      60_000,
    );

    if (!response.ok) {
      return apiError(
        "学習済みvoiceを保存できませんでした。",
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
