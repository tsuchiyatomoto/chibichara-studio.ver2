import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";

const owner = "anon_" + "a".repeat(32);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.endsWith("voice-owner")) return { url: `data:text/javascript,export async function getScopedIrodoriHeaders(){return new Headers()};export async function getVoiceOwnerId(){return '${owner}'}`, shortCircuit: true };
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) return nextResolve(specifier + ".ts", context);
  return nextResolve(specifier, context);
} });
const { movieServerless } = await import("../app/api/_lib/movie-serverless.ts");

function fixture(t) {
  process.env.MOVIE_S3_BUCKET = "test";
  process.env.MOVIE_S3_REGION = "us-east-1";
  process.env.MOVIE_S3_ACCESS_KEY_ID = "local-test";
  process.env.MOVIE_S3_SECRET_ACCESS_KEY = "local-test-secret";
  process.env.RUNPOD_MOVIE_ENDPOINT_ID = "test-endpoint";
  process.env.RUNPOD_API_KEY = "local-runpod-test";
  const files = new Map();
  let revision = 0;
  t.mock.method(S3Client.prototype, "send", async command => {
    const p = command.input;
    const entry = files.get(p.Key);
    switch (command.constructor.name) {
      case "GetObjectCommand":
        if (!entry) throw Object.assign(new Error(), { name: "NoSuchKey" });
        return { ETag: entry.etag, Body: { transformToString: async () => entry.body.toString() } };
      case "PutObjectCommand":
        if ((p.IfMatch && entry?.etag !== p.IfMatch) || (p.IfNoneMatch && entry)) throw Object.assign(new Error(), { name: "PreconditionFailed" });
        files.set(p.Key, { body: Buffer.from(p.Body), etag: String(++revision) });
        return { ETag: String(revision) };
      case "ListObjectsV2Command": return { Contents: [...files.keys()].filter(key => key.startsWith(p.Prefix)).map(Key => ({ Key })) };
      case "DeleteObjectsCommand": for (const { Key } of p.Delete.Objects) files.delete(Key); return {};
      default: throw new Error(command.constructor.name);
    }
  });
  let submits = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/speaker-assets")) return Response.json({ data: [{ id: "vasset_" + "c".repeat(32), created_at: 1 }] });
    if (String(url).endsWith("/content")) return new Response("voice");
    if (String(url).endsWith("/run")) { submits++; assert.equal(JSON.parse(init.body).input.manifest_key.endsWith("/manifest.json"), true); return Response.json({ id: "run-1" }); }
    if (String(url).includes("/status/")) return Response.json({ status: "IN_PROGRESS" });
    throw new Error("unexpected fetch: " + url);
  });
  async function request(path, method = "GET", data, oid = owner) {
    const body = data === undefined ? undefined : Buffer.isBuffer(data) ? data : JSON.stringify(data);
    const req = new Request("http://localhost/api/movie/" + path, { method, body });
    return movieServerless(req, path.split("?")[0].split("/"), oid);
  }
  async function upload() {
    const created = await request("uploads", "POST", { name: "test.mp4", size: 5 });
    assert.equal(created.status, 201);
    const job = await created.json();
    assert.equal((await request(`uploads/${job.id}?offset=0`, "PUT", Buffer.from("movie"))).status, 200);
    assert.equal((await request(`uploads/${job.id}/complete`, "POST", {})).status, 200);
    return job;
  }
  async function ready() {
    const job = await upload();
    const frames = Array.from({ length: 4 }, (_, i) => `avatar-0-${i}.png`);
    for (const frame of frames) assert.equal((await request(`jobs/${job.id}/avatar-assets/${frame}`, "PUT", Buffer.from([137,80,78,71,13,10,26,10]))).status, 200);
    assert.equal((await request(`jobs/${job.id}/avatar`, "POST", { placement: { x: 0, y: 0, scale: 1, rotation: 0, flip_x: false }, poses: [{ id: "pose", label: "pose", frames }] })).status, 200);
    return job;
  }
  return { files, request, upload, ready, submits: () => submits };
}

test("chunk retries are idempotent; owners cannot read or delete each other's jobs", async t => {
  const f = fixture(t);
  const response = await f.request("uploads", "POST", { name: "test.mp4", size: 5 });
  const job = await response.json();
  for (let i = 0; i < 2; i++) {
    const chunk = await f.request(`uploads/${job.id}?offset=0`, "PUT", Buffer.from("movie"));
    assert.deepEqual(await chunk.json(), { received: 5 });
  }
  for (const method of ["GET", "DELETE"]) assert.equal((await f.request(`jobs/${job.id}`, method, undefined, "anon_" + "b".repeat(32))).status, 404);
  assert.equal([...f.files.keys()].filter(k => k.includes("/chunks/")).length, 1);
});

test("conversion submits once and completed output stays downloadable without a worker", async t => {
  const f = fixture(t);
  const job = await f.ready();
  assert.equal((await f.request(`jobs/${job.id}/analyze`, "POST", { glossary: "" })).status, 202);
  assert.equal((await f.request(`jobs/${job.id}/analyze`, "POST", { glossary: "" })).status, 409);
  assert.equal(f.submits(), 1);
  const prefix = `movie-temp/${owner}/${job.id}/`;
  f.files.set(prefix + "result.json", { body: Buffer.from(JSON.stringify({ ...job, state: "completed" })), etag: "result" });
  t.mock.method(globalThis, "fetch", () => { throw new Error("worker is gone"); });
  const status = await f.request(`jobs/${job.id}`);
  assert.equal((await status.json()).state, "completed");
  const download = await f.request(`jobs/${job.id}/files/output.mp4`);
  assert.equal(download.status, 302);
  assert.ok(download.headers.get("location").includes("X-Amz-Signature="));
  const key = prefix + "manifest.json";
  const manifest = JSON.parse(f.files.get(key).body);
  manifest.expires = 0;
  f.files.set(key, { body: Buffer.from(JSON.stringify(manifest)), etag: "expired" });
  assert.equal((await f.request(`jobs/${job.id}/files/output.mp4`)).status, 410);
});

test("simultaneous conversion requests claim the job only once", async t => {
  const f = fixture(t);
  const job = await f.ready();
  const responses = await Promise.all([
    f.request(`jobs/${job.id}/analyze`, "POST", { glossary: "" }),
    f.request(`jobs/${job.id}/analyze`, "POST", { glossary: "" }),
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [202, 409]);
  assert.equal(f.submits(), 1);
});

test("running cancellation waits for worker cleanup and recovers a lost submission receipt", async t => {
  const f = fixture(t);
  const job = await f.ready();
  const prefix = `movie-temp/${owner}/${job.id}/`;
  await f.request(`jobs/${job.id}/analyze`, "POST", { glossary: "" });
  const entry = f.files.get(prefix + "manifest.json");
  const manifest = JSON.parse(entry.body);
  delete manifest.runId;
  f.files.set(prefix + "manifest.json", { ...entry, body: Buffer.from(JSON.stringify(manifest)) });
  f.files.set(prefix + "receipt.json", { body: Buffer.from(JSON.stringify({ runId: "run-1" })), etag: "receipt" });
  assert.equal((await f.request(`jobs/${job.id}/cancel`, "POST", {})).status, 200);
  assert.ok(f.files.has(prefix + "cancel.json"));
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "cancelling");
  assert.equal((await f.request(`jobs/${job.id}`, "DELETE")).status, 409);
  f.files.set(prefix + "result.json", { body: Buffer.from(JSON.stringify({ ...job, state: "cancelled" })), etag: "cancelled" });
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "cancelled");
  assert.equal((await f.request(`jobs/${job.id}`, "DELETE")).status, 200);
});

test("oversized upload and premature completion are rejected", async t => {
  const f = fixture(t);
  assert.equal((await f.request("uploads", "POST", { name: "bad.mp4", size: -1 })).status, 400);
  const job = await (await f.request("uploads", "POST", { name: "test.mp4", size: 5 })).json();
  assert.equal((await f.request(`uploads/${job.id}/complete`, "POST", {})).status, 409);
  assert.equal((await f.request(`uploads/${job.id}?offset=0`, "PUT", Buffer.alloc(6))).status, 400);
});
