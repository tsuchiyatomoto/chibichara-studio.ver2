import "server-only";

const DEFAULT_IRODORI_TTS_BASE_URL = "http://127.0.0.1:8088";

export function getIrodoriBaseUrl() {
  return (
    process.env.IRODORI_TTS_BASE_URL ?? DEFAULT_IRODORI_TTS_BASE_URL
  ).replace(/\/+$/, "");
}

export function getIrodoriHeaders() {
  const headers = new Headers();

  if (process.env.IRODORI_TTS_API_KEY) {
    headers.set(
      "Authorization",
      `Bearer ${process.env.IRODORI_TTS_API_KEY}`,
    );
  }

  return headers;
}

export async function fetchIrodori(
  path: string,
  init: RequestInit,
  timeoutMs = 30_000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(`${getIrodoriBaseUrl()}${path}`, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function getIrodoriErrorDetail(response: Response) {
  const text = await response.text();

  if (!text) {
    return `${response.status} ${response.statusText}`.trim();
  }

  try {
    const data = JSON.parse(text) as {
      detail?: unknown;
      error?: unknown;
      message?: unknown;
    };
    const value = data.detail ?? data.error ?? data.message;

    if (typeof value === "string") {
      return value;
    }

    if (
      typeof value === "object" &&
      value !== null &&
      "message" in value &&
      typeof value.message === "string"
    ) {
      return value.message;
    }
  } catch {
    // Fall through and return the original response body.
  }

  return text;
}

export function apiError(message: string, status: number, detail?: string) {
  return Response.json(
    { error: message, ...(detail ? { detail } : {}) },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}
