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
  let runtime = () => Response.json({ status: "IN_PROGRESS" });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/speaker-assets")) return Response.json({ data: [{ id: "vasset_" + "c".repeat(32), created_at: 1 }] });
    if (String(url).endsWith("/content")) return new Response("voice");
    if (String(url).endsWith("/run")) { submits++; assert.equal(JSON.parse(init.body).input.manifest_key.endsWith("/manifest.json"), true); return Response.json({ id: "run-1" }); }
    if (String(url).includes("/status/")) return runtime(url, init);
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
  async function submitted() {
    const job = await ready();
    assert.equal((await request(`jobs/${job.id}/analyze`, "POST", { glossary: "" })).status, 202);
    return { job, prefix: `movie-temp/${owner}/${job.id}/` };
  }
  return { files, request, upload, ready, submitted, setRuntime: handler => { runtime = handler; }, submits: () => submits };
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

test("a missing Runpod job stops after three checks and can be checked again without resubmitting", async t => {
  const f = fixture(t);
  const { job, prefix } = await f.submitted();
  let checks = 0;
  const logs = [];
  t.mock.method(console, "warn", line => logs.push(JSON.parse(line)));
  f.setRuntime(() => { checks++; return Response.json({ error: "private-provider-detail" }, { status: 404 }); });
  const response = await f.request(`jobs/${job.id}`);
  const unknown = await response.json();
  assert.equal(response.status, 200);
  assert.equal(unknown.state, "status_unknown");
  assert.match(unknown.message, /状況を再確認/);
  assert.equal(checks, 3);
  assert.equal(f.files.has(prefix + "failure.json"), false);
  assert.equal(f.files.has(prefix + "result.json"), false);
  assert.ok(logs.some(log => log.jobId === job.id && log.runId === "run-1" && log.httpStatus === 404 && log.stage === "status"));
  assert.equal(JSON.stringify(logs).includes("private-provider-detail"), false);
  assert.equal(JSON.stringify(logs).includes("local-runpod-test"), false);
  f.setRuntime(() => Response.json({ status: "IN_PROGRESS" }));
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "analyzing");
  assert.equal(f.submits(), 1);
});

test("one transient 404 recovers on the next status check", async t => {
  const f = fixture(t);
  const { job } = await f.submitted();
  let checks = 0;
  f.setRuntime(() => ++checks === 1 ? new Response(null, { status: 404 }) : Response.json({ status: "IN_PROGRESS" }));
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "analyzing");
  assert.equal(checks, 2);
});

test("completion published during a 404 response wins immediately", async t => {
  const f = fixture(t);
  const { job, prefix } = await f.submitted();
  let checks = 0;
  f.setRuntime(() => {
    checks++;
    f.files.set(prefix + "result.json", { body: Buffer.from(JSON.stringify({ ...job, state: "completed" })), etag: "completed" });
    return new Response(null, { status: 404 });
  });
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "completed");
  assert.equal(checks, 1);
  assert.equal(f.files.has(prefix + "failure.json"), false);
});

for (const remote of ["FAILED", "TIMED_OUT", "CANCELLED"]) {
  test(`${remote} is retained after Runpod history disappears; a later completed result takes priority`, async t => {
    const f = fixture(t);
    const { job, prefix } = await f.submitted();
    f.setRuntime(() => Response.json({ status: remote }));
    const expected = remote === "CANCELLED" ? "cancelled" : "failed";
    assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, expected);
    const record = JSON.parse(f.files.get(prefix + "failure.json").body);
    assert.equal(record.terminal, true);
    assert.equal(record.code, remote);
    assert.equal(f.files.has(prefix + "result.json"), false);
    f.setRuntime(() => { throw new Error("Runpod history has gone"); });
    assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, expected);
    f.files.set(prefix + "result.json", { body: Buffer.from(JSON.stringify({ ...job, state: "completed" })), etag: "completed" });
    assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "completed");
    assert.equal((await f.request(`jobs/${job.id}/files/output.mp4`)).status, 302);
  });
}

test("completion during failure persistence cannot be overwritten", async t => {
  const f = fixture(t);
  const { job, prefix } = await f.submitted();
  const send = S3Client.prototype.send;
  t.mock.method(S3Client.prototype, "send", async function(command) {
    if (command.constructor.name === "PutObjectCommand" && command.input.Key === prefix + "failure.json") {
      f.files.set(prefix + "result.json", { body: Buffer.from(JSON.stringify({ ...job, state: "completed" })), etag: "completed" });
    }
    return send.call(this, command);
  });
  f.setRuntime(() => Response.json({ status: "FAILED" }));
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "completed");
  assert.equal(JSON.parse(f.files.get(prefix + "result.json").body).state, "completed");
});

test("a worker failure does not stop a provider retry and survives a later missing history", async t => {
  const f = fixture(t);
  const { job, prefix } = await f.submitted();
  f.files.set(prefix + "failure.json", { etag: "attempt", body: Buffer.from(JSON.stringify({
    job: { ...job, state: "failed" }, runId: "run-1", terminal: false, stage: "analyze", code: "worker_failed", errorType: "HTTPStatusError", httpStatus: 403,
  })) });
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "analyzing");
  const logs = [];
  t.mock.method(console, "warn", line => logs.push(JSON.parse(line)));
  f.setRuntime(() => new Response(null, { status: 404 }));
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "failed");
  const record = JSON.parse(f.files.get(prefix + "failure.json").body);
  assert.equal(record.stage, "analyze");
  assert.equal(record.errorType, "HTTPStatusError");
  assert.equal(record.httpStatus, 403);
  assert.ok(logs.some(log => log.code === "worker_failed" && log.errorType === "HTTPStatusError" && log.httpStatus === 403 && log.stage === "analyze"));
  assert.equal(record.terminal, true);
});

for (const status of [404, 503]) {
  test(`one job's upstream ${status} does not prevent listing another completed video`, async t => {
    const f = fixture(t);
    const { job: missing } = await f.submitted();
    const { job: completed, prefix } = await f.submitted();
    f.files.set(prefix + "result.json", { body: Buffer.from(JSON.stringify({ ...completed, state: "completed" })), etag: "completed" });
    f.setRuntime(() => new Response(null, { status }));
    const response = await f.request("jobs");
    assert.equal(response.status, 200);
    const { jobs } = await response.json();
    assert.equal(jobs.length, 2);
    assert.equal(jobs.find(job => job.id === missing.id).state, "status_unknown");
    assert.equal(jobs.find(job => job.id === completed.id).state, "completed");
  });
}

test("unknown jobs cannot be deleted or resubmitted; cancellation still reaches storage", async t => {
  const f = fixture(t);
  const { job, prefix } = await f.submitted();
  f.setRuntime(() => new Response(null, { status: 404 }));
  assert.equal((await f.request(`jobs/${job.id}`, "DELETE")).status, 409);
  assert.ok(f.files.has(prefix + "manifest.json"));
  assert.equal((await f.request(`jobs/${job.id}/analyze`, "POST", { glossary: "" })).status, 409);
  assert.equal((await f.request(`jobs/${job.id}/cancel`, "POST", {})).status, 200);
  assert.ok(f.files.has(prefix + "cancel.json"));
  assert.equal(f.submits(), 1);
});

test("a completed status without saved output is unknown and recovers after output publication", async t => {
  const f = fixture(t);
  const { job, prefix } = await f.submitted();
  f.setRuntime(() => Response.json({ status: "COMPLETED" }));
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "status_unknown");
  assert.equal(f.files.has(prefix + "failure.json"), false);
  f.files.set(prefix + "result.json", { body: Buffer.from(JSON.stringify({ ...job, state: "completed" })), etag: "completed" });
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "completed");
});

test("a stale attempt from another Runpod job is not treated as this job's failure", async t => {
  const f = fixture(t);
  const { job, prefix } = await f.submitted();
  f.files.set(prefix + "failure.json", { etag: "stale", body: Buffer.from(JSON.stringify({
    job: { ...job, state: "failed" }, runId: "different-run", terminal: true, stage: "analyze", code: "worker_failed",
  })) });
  f.setRuntime(() => new Response(null, { status: 404 }));
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "status_unknown");
});

test("unknown provider statuses do not leave a video analyzing forever", async t => {
  const f = fixture(t);
  const { job } = await f.submitted();
  f.setRuntime(() => Response.json({ status: "UNKNOWN" }));
  assert.equal((await (await f.request(`jobs/${job.id}`)).json()).state, "status_unknown");
});

test("a manifest removed after object listing does not hide the other videos", async t => {
  const f = fixture(t);
  const { prefix: removed } = await f.submitted();
  const { job: completed, prefix } = await f.submitted();
  f.files.set(prefix + "result.json", { body: Buffer.from(JSON.stringify({ ...completed, state: "completed" })), etag: "completed" });
  const send = S3Client.prototype.send;
  t.mock.method(S3Client.prototype, "send", async function(command) {
    if (command.constructor.name === "GetObjectCommand" && command.input.Key === removed + "manifest.json") f.files.delete(command.input.Key);
    return send.call(this, command);
  });
  const response = await f.request("jobs");
  assert.equal(response.status, 200);
  const { jobs } = await response.json();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, completed.id);
  assert.equal(jobs[0].state, "completed");
});
