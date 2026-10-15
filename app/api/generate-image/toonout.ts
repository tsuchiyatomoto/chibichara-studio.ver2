const WORKER_URL = (process.env.TOONOUT_WORKER_URL ?? "http://127.0.0.1:8091").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.TOONOUT_TIMEOUT_MS ?? 180000);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

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
  try {
    const response = await fetch(`${WORKER_URL}/health`, {
      headers: headers(),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new ToonOutError(`ToonOut is not ready (${await failure(response)}).`);
  } catch (error) {
    if (error instanceof ToonOutError) throw error;
    throw new ToonOutError("ToonOut background-removal worker is unavailable. Start it and try again.");
  }
}

export async function removeBackground(data: string, mimeType: string) {
  try {
    const response = await fetch(`${WORKER_URL}/remove-background`, {
      method: "POST",
      headers: headers(mimeType),
      body: Buffer.from(data, "base64"),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new ToonOutError(`ToonOut failed (${await failure(response)}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.length === 0 || bytes.length > MAX_OUTPUT_BYTES ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      throw new ToonOutError("ToonOut returned an invalid PNG image.");
    }
    return bytes.toString("base64");
  } catch (error) {
    if (error instanceof ToonOutError) throw error;
    throw new ToonOutError("ToonOut background removal timed out or disconnected.");
  }
}
