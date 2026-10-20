import { toonoutServerlessEnabled, ensureToonoutConfigured, submitImage } from "../_lib/service-serverless";

const WORKER_URL = (process.env.TOONOUT_WORKER_URL ?? "http://127.0.0.1:8091").replace(/\/+$/, "");

export class ToonOutError extends Error {}

function headers(contentType?: string) {
  const token = process.env.TOONOUT_WORKER_TOKEN;
  if (!token) {
    throw new ToonOutError("ToonOut worker token is not configured. Start the ToonOut worker first.");
  }
  return {
    Authorization: `Bearer ${token}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

async function failure(response: Response) {
  try {
    const data = await response.json() as { error?: unknown; detail?: unknown };
    const detail = typeof data.error === "string" ? data.error
      : typeof data.detail === "string" ? data.detail : undefined;
    return detail ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function ensureToonOutReady() {
  if (toonoutServerlessEnabled()) { await ensureToonoutConfigured(); return; }
  try {
    const response = await fetch(`${WORKER_URL}/health`, {
      headers: headers(),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new ToonOutError(`ToonOut is not ready (${await failure(response)}).`);
    const health = await response.json() as { jobs?: boolean };
    if (!health.jobs) throw new ToonOutError("Restart the ToonOut worker to enable background jobs before generating images.");
  } catch (error) {
    if (error instanceof ToonOutError) throw error;
    throw new ToonOutError("ToonOut background-removal worker is unavailable. Start it and try again.");
  }
}

export async function submitBackgroundRemoval(data: string, mimeType: string, owner: string) {
  if (toonoutServerlessEnabled()) return submitImage(owner, data, mimeType);
  const key = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
    const response = await fetch(`${WORKER_URL}/jobs`, {
      method: "POST",
      headers: { ...headers(mimeType), "X-Job-Owner": owner, "Idempotency-Key": key },
      body: Buffer.from(data, "base64"),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new ToonOutError(`ToonOut failed (${await failure(response)}).`);
    const job = await response.json() as { id?: string; status?: string };
    if (!job.id || !/^job_[a-f0-9]{32}$/.test(job.id)) throw new ToonOutError("ToonOut returned an invalid job.");
    return job;
    } catch (error) {
      if (error instanceof ToonOutError) throw error;
      if (attempt === 2) throw new ToonOutError("ToonOut background removal timed out or disconnected.");
    }
  }
  throw new ToonOutError("ToonOut job could not be submitted.");
}
