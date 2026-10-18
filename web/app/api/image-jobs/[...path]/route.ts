import { proxyWorkerJob } from "../../_lib/proxy-worker-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxyWorkerJob(request, (await context.params).path, "image");
}

export { proxy as GET, proxy as DELETE };
