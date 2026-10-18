import "server-only";
import { getVoiceOwnerId } from "./voice-owner";

export async function proxyWorkerJob(request: Request, parts: string[], kind: "speech" | "image") {
  if (parts.length < 1 || parts.length > 2 || !/^job_[a-f0-9]{32}$/.test(parts[0]) ||
      (parts.length === 2 && parts[1] !== "content") ||
      !["GET", "DELETE"].includes(request.method) || (parts.length === 2 && request.method !== "GET")) {
    return Response.json({ error: "ジョブのパスが不正です。" }, { status: 400 });
  }
  const token = kind === "speech" ? process.env.IRODORI_TTS_API_KEY : process.env.TOONOUT_WORKER_TOKEN;
  const base = kind === "speech"
    ? process.env.IRODORI_TTS_BASE_URL ?? "http://127.0.0.1:8088"
    : process.env.TOONOUT_WORKER_URL ?? "http://127.0.0.1:8091";
  const prefix = kind === "speech" ? "/v1/audio/speech-jobs/" : "/jobs/";
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set(kind === "speech" ? "X-Irodori-Owner-ID" : "X-Job-Owner", await getVoiceOwnerId());
  try {
    const response = await fetch(`${base.replace(/\/+$/, "")}${prefix}${parts.join("/")}`, {
      method: request.method, headers, cache: "no-store", signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return Response.json({ error: response.status === 404
      ? "生成ジョブが見つかりません。期限切れの場合は再生成してください。"
      : "生成ジョブを取得できませんでした。" }, { status: response.status });
    return new Response(response.body, { status: response.status, headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": response.headers.get("content-type") ?? "application/json",
    } });
  } catch {
    return Response.json({ error: "生成サーバーに接続できません。時間をおいて再試行してください。" }, { status: 503 });
  }
}
