import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
    if (context.parentURL?.includes("/app/api/speaker-assets/route.ts")) {
      if (specifier === "../_lib/irodori") {
        return nextResolve(new URL("../_lib/irodori.ts", context.parentURL).href, context);
      }
      if (specifier === "../_lib/voice-owner") {
        return { url: "data:text/javascript," + encodeURIComponent(
          'export async function getScopedIrodoriHeaders() { return new Headers({"X-Irodori-Owner-ID":"anon_test-owner"}); }',
        ), shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { DELETE } = await import("../app/api/speaker-assets/route.ts");
const voiceAssetId = `vasset_${"a".repeat(32)}`;
function request(body) {
  return new Request("http://localhost/api/speaker-assets", {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

for (const status of [204, 404]) {
  test(`model deletion forwards the owner and treats upstream ${status} as deleted`, async (t) => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status });
    });
    const response = await DELETE(request({ voiceAssetId }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true, voiceAssetId });
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).pathname, `/v1/audio/voice-assets/${voiceAssetId}`);
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(calls[0].init.headers.get("X-Irodori-Owner-ID"), "anon_test-owner");
    assert.equal(calls[0].init.cache, "no-store");
  });
}

test("invalid model IDs never reach the audio server", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream call"); });
  for (const body of [{}, { voiceAssetId: "../another-owner/model" }, { voiceAssetId: 123 }, null]) {
    assert.equal((await DELETE(request(body))).status, 400);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("a server error cannot be reported as successful model deletion", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unavailable" }, { status: 503 }));
  const response = await DELETE(request({ voiceAssetId }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ボイスモデルの削除に失敗/);
});

test("an unreachable audio server returns a retryable deletion error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const response = await DELETE(request({ voiceAssetId }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ボイスモデルを削除できませんでした/);
});
