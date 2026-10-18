import { ApiError } from "@google/genai";
import { randomUUID } from "node:crypto";
import timers from "node:timers/promises";

const MAX_ATTEMPTS = 6;
// Match the retryable HTTP statuses and backoff used by the installed SDK.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function parseResponseBody(message: string): unknown {
  try {
    return JSON.parse(message);
  } catch {
    return message;
  }
}

export async function withVertexImageRetries<T>(
  generate: () => Promise<T>,
  context: { model: string; location: string; signal: AbortSignal },
): Promise<T> {
  const requestId = randomUUID();

  for (let attempt = 1; ; attempt += 1) {
    context.signal.throwIfAborted();

    try {
      return await generate();
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }

      // ApiError.message contains the response body when SDK retries are off.
      // Serialize explicitly so Node's object inspection cannot truncate details.
      console.error(
        JSON.stringify({
          event: "vertex_image_api_error",
          timestamp: new Date().toISOString(),
          requestId,
          model: context.model,
          location: context.location,
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          status: error.status,
          responseBody: parseResponseBody(error.message),
        }),
      );

      if (
        attempt >= MAX_ATTEMPTS ||
        !RETRYABLE_STATUSES.has(error.status) ||
        context.signal.aborted
      ) {
        throw error;
      }

      await timers.setTimeout(1000 * 2 ** (attempt - 1), undefined, {
        signal: context.signal,
      });
    }
  }
}
