import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
const owner = "anon_" + "a".repeat(32);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.endsWith("voice-owner")) return { url: "data:text/javascript,export async function getVoiceOwnerId(){return '" + owner + "'};export async function getScopedIrodoriHeaders(){return new Headers()}", shortCircuit: true };
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) return nextResolve(specifier + ".ts", context);
  return nextResolve(specifier, context);
}});
const service = await import("../app/api/_lib/service-serverless.ts");
const speechRoute = await import("../app/api/generate-speech/route.ts");
const { proxyWorkerJob } = await import("../app/api/_lib/proxy-worker-job.ts");
const { movieServerless } = await import("../app/api/_lib/movie-serverless.ts");
const oid = "anon_" + "b".repeat(32);
function fixture(t) {
  Object.assign(process.env, {
    MOVIE_S3_BUCKET: "test", MOVIE_S3_REGION: "auto", MOVIE_S3_ACCESS_KEY_ID: "test", MOVIE_S3_SECRET_ACCESS_KEY: "test",
    VOICE_BACKEND: "runpod", TOONOUT_BACKEND: "runpod", RUNPOD_VOICE_ENDPOINT_ID: "voice", RUNPOD_TOONOUT_ENDPOINT_ID: "image",
    RUNPOD_API_KEY: "test", RUNPOD_MOVIE_ENDPOINT_ID: "movie",
  });
  const files = new Map();
  let revision = 0, submissions = 0;
  t.mock.method(S3Client.prototype, "send", async command => {
    const p = command.input, entry = files.get(p.Key);
    switch (command.constructor.name) {
      case "GetObjectCommand":
        if (!entry) throw Object.assign(new Error(), { name: "NoSuchKey" });
        return { ETag: entry.etag, ContentLength: entry.body.length, Body: {
          transformToString: async () => entry.body.toString(),
          transformToWebStream: () => new ReadableStream({ start(c) { c.enqueue(entry.body); c.close(); } }),
        } };
      case "PutObjectCommand":
        if ((p.IfMatch && entry?.etag !== p.IfMatch) || (p.IfNoneMatch && entry)) throw Object.assign(new Error(), { name: "PreconditionFailed" });
        files.set(p.Key, { body: Buffer.from(p.Body), etag: String(++revision) }); return { ETag: String(revision) };
      case "ListObjectsV2Command": return { Contents: [...files.keys()].filter(key => key.startsWith(p.Prefix)).map(Key => ({ Key })) };
      case "DeleteObjectsCommand": for (const { Key } of p.Delete.Objects) files.delete(Key); return {};
      default: throw new Error(command.constructor.name);
    }
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/run")) { submissions++; return Response.json({ id: "remote-" + submissions }); }
    if (String(url).includes("/status/")) return Response.json({ status: "IN_PROGRESS" });
    if (String(url).endsWith("/health")) return Response.json({ workers: { ready: 0, idle: 0 }, jobs: { inQueue: 0 } });
    throw new Error("Unexpected network request: " + url);
  });
  const put = (key, value) => files.set(key, { body: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)), etag: String(++revision) });
  const prefix = (kind, id) => "movie-temp/services/" + owner + "/" + kind + "/" + id + "/";
  return { files, put, prefix, submissions: () => submissions };
}
function request(body = { input: "こんにちは", caption: "", speed: 1, voice: "none", voiceAssetId: "" }, key = "same-request-12345678") {
  return new Request("http://local/api/generate-speech", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
}
function trainingForm() {
  const form = new FormData();
  form.set("voice_id", "マイボイス");
  form.set("texts", JSON.stringify(Array(5).fill("こんにちは")));
  for (let i = 0; i < 5; i++) form.append("files", new File(["RIFFtest"], "sample.wav"));
  return form;
}
test("speech route retries and simultaneous requests dispatch once; changed input conflicts", async t => {
  const f = fixture(t);
  const results = await Promise.all([speechRoute.POST(request()), speechRoute.POST(request())]);
  assert.ok(results.every(response => response.status === 202));
  const jobs = await Promise.all(results.map(r => r.json()));
  assert.equal(jobs[0].id, jobs[1].id);
  assert.equal(f.submissions(), 1);
  assert.equal((await speechRoute.POST(request({ input: "別の内容", voice: "none" }))).status, 409);
  assert.equal((await speechRoute.POST(request({ input: "x".repeat(4097) }))).status, 400);
});
test("results remain downloadable after workers and API credentials are gone; owner and expiry are enforced", async t => {
  const f = fixture(t);
  const job = await (await speechRoute.POST(request())).json();
  const prefix = f.prefix("speech", job.id);
  f.put(prefix + "result.json", { ...job, status: "completed" });
  f.put(prefix + "result.wav", Buffer.from("RIFF-test-result"));
  delete process.env.RUNPOD_API_KEY;
  t.mock.method(globalThis, "fetch", () => { throw new Error("Worker is stopped"); });
  assert.equal((await proxyWorkerJob(new Request("http://local"), [job.id], "speech")).status, 200);
  const download = await proxyWorkerJob(new Request("http://local"), [job.id, "content"], "speech");
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "audio/wav");
  assert.equal(download.headers.get("location"), null);
  assert.equal(await download.text(), "RIFF-test-result");
  assert.equal((await service.serviceJob(oid, "speech", job.id, "GET")).status, 404);
  const m = JSON.parse(f.files.get(prefix + "manifest.json").body);
  f.put(prefix + "manifest.json", { ...m, expires: 0 });
  assert.equal((await service.serviceJob(owner, "speech", job.id, "GET", true)).status, 410);
});
test("a lost submit acknowledgement never triggers duplicate execution and recovers worker receipt", async t => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).endsWith("/run")) { calls++; throw new Error("Acknowledgement lost"); }
    return Response.json({ status: "IN_PROGRESS" });
  });
  const job = await (await speechRoute.POST(request())).json();
  await speechRoute.POST(request());
  assert.equal(calls, 1);
  f.put(f.prefix("speech", job.id) + "receipt.json", { runId: "recovered-id" });
  assert.equal((await service.getJob(owner, "speech", job.id)).status, "running");
});

test("definite Runpod submission rejection produces a failed job instead of waiting forever", async t => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 401 }));
  const job = await (await speechRoute.POST(request())).json();
  assert.equal(job.status, "failed");
  assert.equal((await service.getJob(owner, "speech", job.id)).status, "failed");
  assert.ok(f.files.has(f.prefix("speech", job.id) + "result.json"));
});
test("training can be saved and used for speech and Movie entirely through R2", async t => {
  const f = fixture(t);
  const job = await (await service.submitTraining(owner, request(), trainingForm())).json();
  const prefix = f.prefix("training", job.id), bytes = Buffer.from("trained-embedding");
  f.put(prefix + "result.json", { ...job, status: "completed", result: { voice_id: "マイボイス", filename: "result.speaker.safetensors", saved: false } });
  f.put(prefix + "result.speaker.safetensors", bytes);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Voice worker is stopped"); });
  const saved = await (await service.saveTrainedVoice(owner, job.id, "保存した声")).json();
  assert.equal(saved.persistent, true);
  assert.equal(saved.expires_at, null);
  assert.deepEqual(await service.latestVoiceBytes(owner), bytes);
  assert.equal((await service.listVoiceAssets(oid)).length, 0);
  const savedAgain = await (await service.saveTrainedVoice(owner, job.id, "保存した声")).json();
  assert.equal(savedAgain.id, saved.id);
  assert.equal((await service.getJob(owner, "training", job.id)).result.saved_asset_id, saved.id);
  // Training manifests cannot appear in Movie's upload/job listing.
  const health = await movieServerless(new Request("http://local"), ["health"], owner);
  assert.equal((await health.json()).voice_available, true);
  assert.equal((await (await movieServerless(new Request("http://local"), ["jobs"], owner)).json()).jobs.length, 0);
  const preview = await service.submitSpeech(owner, request(), { input: "テスト", caption: "", speed: 1, voice: "none", voiceAssetId: saved.id });
  assert.equal(preview.status, 202);
  const previewJob = await preview.json();
  const m = JSON.parse(f.files.get(f.prefix("speech", previewJob.id) + "manifest.json").body);
  assert.equal(m.payload.asset_kind, "speaker_embedding");
  assert.deepEqual(f.files.get(m.files[0].key).body, bytes);
  await service.removeVoiceAsset(owner, saved.id);
  assert.equal((await service.listVoiceAssets(owner)).length, 0);
  assert.equal((await service.getJob(owner, "training", job.id)).result.saved, false);
});
test("temporary references are owner scoped and snapshotted into the job before deletion", async t => {
  const f = fixture(t);
  const asset = await (await service.createVoiceReference(owner, new File(["RIFFtest"], "reference.wav"))).json();
  const body = { input: "テスト", caption: "", speed: 1, voice: "none", voiceAssetId: asset.voiceAssetId };
  assert.equal((await service.serviceResponse(() => service.submitSpeech(oid, request(), body))).status, 404);
  const job = await (await service.submitSpeech(owner, request(), body)).json();
  await service.removeVoiceAsset(owner, asset.voiceAssetId);
  const m = JSON.parse(f.files.get(f.prefix("speech", job.id) + "manifest.json").body);
  assert.equal(f.files.get(m.files[0].key).body.toString(), "RIFFtest");
});
test("image cancellation remains pending until the worker confirms; failed remote jobs are terminal", async t => {
  const f = fixture(t);
  const job = await service.submitImage(owner, "aW1hZ2U=", "image/png");
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "IN_PROGRESS" }));
  const cancellation = await service.serviceJob(owner, "image", job.id, "DELETE");
  assert.equal((await cancellation.json()).status, "cancelling");
  assert.equal((await service.getJob(owner, "image", job.id)).status, "cancelling");
  f.put(f.prefix("image", job.id) + "result.json", { ...job, status: "cancelled" });
  assert.equal((await service.getJob(owner, "image", job.id)).status, "cancelled");
  assert.equal((await service.serviceJob(owner, "image", job.id, "GET", true)).status, 409);
});
test("invalid training input is rejected before any GPU job is submitted", async t => {
  const f = fixture(t), form = trainingForm();
  form.set("texts", JSON.stringify(["only one"]));
  assert.equal((await service.serviceResponse(() => service.submitTraining(owner, request(), form))).status, 400);
  assert.equal(f.submissions(), 0);
});

test("connection checks validate Runpod credentials without starting GPU jobs", async t => {
  const f = fixture(t);
  assert.equal((await service.voiceHealth()).status, 200);
  await service.ensureToonoutConfigured();
  assert.equal(f.submissions(), 0);
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 401 }));
  assert.equal((await service.voiceHealth()).status, 503);
  await assert.rejects(service.ensureToonoutConfigured());
});
