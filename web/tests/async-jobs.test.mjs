import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
    if (specifier.endsWith("voice-owner")) return {
      url: "data:text/javascript,export async function getVoiceOwnerId() { return 'anon_' + 'a'.repeat(32); }", shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});

const { POST } = await import("../app/api/generate-speech/route.ts");
const { proxyWorkerJob } = await import("../app/api/_lib/proxy-worker-job.ts");
const jobId = "job_" + "b".repeat(32);

test("speech generation returns 202 immediately and forwards an owner and retry key", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).pathname, "/v1/audio/speech-jobs");
    assert.equal(init.headers.get("X-Irodori-Owner-ID"), "anon_" + "a".repeat(32));
    assert.equal(init.headers.get("Idempotency-Key"), "request_" + "c".repeat(24));
    assert.equal(JSON.parse(init.body).input, "こんにちは");
    return Response.json({ id: jobId, status: "queued" }, { status: 202 });
  });
  const response = await POST(new Request("http://localhost/api/generate-speech", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "request_" + "c".repeat(24) },
    body: JSON.stringify({ input: "こんにちは" }),
  }));
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("location"), `/api/speech-jobs/${jobId}`);
  assert.equal((await response.json()).status, "queued");
});

test("job proxy validates paths before calling a worker", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("must not call"); });
  for (const path of [["../private"], [jobId, "anything"], [jobId, "content", "more"]]) {
    assert.equal((await proxyWorkerJob(new Request("http://localhost"), path, "speech")).status, 400);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("image result proxy forwards owner identity and streams completed content", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).pathname, `/jobs/${jobId}/content`);
    assert.equal(init.headers.get("X-Job-Owner"), "anon_" + "a".repeat(32));
    return new Response("png-bytes", { headers: { "Content-Type": "image/png" } });
  });
  const result = await proxyWorkerJob(new Request("http://localhost"), [jobId, "content"], "image");
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(await result.text(), "png-bytes");
});

test("expired or foreign-owner jobs remain inaccessible through the proxy", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ detail: "not found" }, { status: 404 }));
  const response = await proxyWorkerJob(new Request("http://localhost"), [jobId], "speech");
  assert.equal(response.status, 404);
});
