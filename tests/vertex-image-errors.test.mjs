import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { ApiError, GoogleGenAI } from "@google/genai";
import { withVertexImageRetries } from "../app/api/generate-image/vertex-retry.ts";

const quotaBody = {
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "Quota exceeded for the test project.",
    details: [{
      "@type": "type.googleapis.com/google.rpc.QuotaFailure",
      violations: [{ subject: "test-quota", description: "detail".repeat(2000) }],
    }],
  },
};
const successBody = {
  candidates: [{ content: { parts: [{ inlineData: {
    mimeType: "image/png", data: "dGVzdA==",
  } }] } }],
};

function setup(t, responses) {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    const response = responses.shift();
    assert.ok(response, "Unexpected extra HTTP request");
    return response;
  });
  const logMock = t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Use the real installed SDK, with HTTP mocked before any network traffic.
  const ai = new GoogleGenAI({ vertexai: true, apiKey: "unused-test-key" });
  const controller = new AbortController();
  return {
    fetchMock,
    controller,
    records: () => logMock.mock.calls.map(({ arguments: args }) => JSON.parse(args[0])),
    run: () => withVertexImageRetries(
      () => ai.models.generateContent({
        model: "gemini-3.1-flash-image",
        contents: "private test prompt",
        config: { abortSignal: controller.signal },
      }),
      { model: "gemini-3.1-flash-image", location: "global", signal: controller.signal },
    ),
  };
}

async function advanceRetry(t, milliseconds) {
  // Let the SDK finish reading the mocked response before advancing its delay.
  await setImmediate();
  t.mock.timers.tick(milliseconds);
  await setImmediate();
}

test("logs the full Vertex quota response before retrying successfully", async (t) => {
  const state = setup(t, [
    Response.json(quotaBody, { status: 429, statusText: "Too Many Requests" }),
    Response.json(successBody),
  ]);
  const pending = state.run();
  await setImmediate();
  assert.equal(state.fetchMock.mock.callCount(), 1);
  assert.deepEqual(state.records()[0].responseBody, quotaBody);
  await advanceRetry(t, 999);
  assert.equal(state.fetchMock.mock.callCount(), 1);
  await advanceRetry(t, 1);
  const result = await pending;
  assert.equal(result.candidates[0].content.parts[0].inlineData.data, "dGVzdA==");
  assert.equal(state.records().length, 1);
  const record = state.records()[0];
  assert.equal(record.event, "vertex_image_api_error");
  assert.equal(record.status, 429);
  assert.equal(record.attempt, 1);
  assert.ok(!Number.isNaN(Date.parse(record.timestamp)));
  assert.ok(!JSON.stringify(record).includes("private test prompt"));
  assert.ok(!JSON.stringify(record).includes("unused-test-key"));
});

test("logs all six failed attempts with one request ID and preserves the final body", async (t) => {
  const state = setup(t, Array.from({ length: 6 }, () => Response.json(quotaBody, { status: 429 })));
  const rejected = assert.rejects(state.run(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 429);
    assert.deepEqual(JSON.parse(error.message), quotaBody);
    return true;
  });
  for (const milliseconds of [1000, 2000, 4000, 8000, 16000]) {
    await advanceRetry(t, milliseconds);
  }
  await rejected;
  assert.equal(state.fetchMock.mock.callCount(), 6);
  const records = state.records();
  assert.deepEqual(records.map(({ attempt }) => attempt), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(records.map(({ requestId }) => requestId)).size, 1);
  for (const record of records) {
    assert.equal(record.maxAttempts, 6);
    assert.deepEqual(record.responseBody, quotaBody);
  }
});

test("logs a non-retryable response once without another request", async (t) => {
  const body = { error: { code: 403, message: "Permission denied", status: "PERMISSION_DENIED" } };
  const state = setup(t, [Response.json(body, { status: 403 })]);
  await assert.rejects(state.run(), { status: 403 });
  assert.equal(state.fetchMock.mock.callCount(), 1);
  assert.deepEqual(state.records()[0].responseBody, body);
});

test("keeps a non-JSON error body supplied by the SDK", async (t) => {
  const body = "<html>Upstream unavailable</html>";
  const state = setup(t, [
    new Response(body, { status: 503, statusText: "Service Unavailable", headers: { "content-type": "text/html" } }),
    Response.json(successBody),
  ]);
  const pending = state.run();
  await advanceRetry(t, 1000);
  await pending;
  assert.equal(state.records()[0].status, 503);
  assert.equal(state.records()[0].responseBody.error.message, body);
});

test("aborting the shared timeout stops retrying after the recorded failure", async (t) => {
  const state = setup(t, [Response.json(quotaBody, { status: 429 })]);
  const rejected = assert.rejects(state.run(), { name: "AbortError" });
  await setImmediate();
  state.controller.abort();
  await rejected;
  await advanceRetry(t, 31000);
  assert.equal(state.fetchMock.mock.callCount(), 1);
  assert.equal(state.records().length, 1);
});
