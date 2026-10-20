import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { MovieHttpError, MOVIE_TTL, readJson, readFile, putFile, listKeys, deletePrefix, limitedBody } from "./movie-storage";

type Kind = "speech" | "training" | "image";
type PublicJob = {
  id: string; status: string; error: string | null; created_at: string; updated_at: string;
  voice_id?: string; phase?: string; sample_count?: number; message?: string;
  progress?: { current: number; total: number; ratio: number };
  result?: null | { filename: string; voice_id: string; saved: boolean; registered: boolean; saved_asset_id: string | null; expires_at: string };
};
type InputFile = { key: string; sha256: string; name: string; type: string; bytes: number };
type Manifest = {
  version: 1; owner: string; kind: Kind; id: string; expires: number; fingerprint: string;
  endpoint: string; payload: Record<string, unknown>; files: InputFile[]; job: PublicJob;
};
export type VoiceAsset = {
  id: string; object: "voice_asset"; name: string; kind: "speaker_embedding" | "reference_audio";
  filename: string; bytes: number; created_at: string; expires_at: string | null; persistent: boolean;
};
type StoredAsset = { owner: string; asset: VoiceAsset; key: string };
const now = () => Date.now() / 1000;
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const uuid = () => randomUUID().replaceAll("-", "");
const terminal = new Set(["completed", "failed", "cancelled"]);
class RunpodRejected extends MovieHttpError {}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
export const voiceServerlessEnabled = () => process.env.VOICE_BACKEND === "runpod";
export const toonoutServerlessEnabled = () => process.env.TOONOUT_BACKEND === "runpod";
const base = (owner: string) => {
  if (!/^anon_[a-f0-9]{32}$/.test(owner)) throw new MovieHttpError(400, "利用者IDが不正です。");
  return "movie-temp/services/" + owner + "/";
};
const jobPrefix = (owner: string, kind: Kind, id: string) => {
  if (!(kind === "training" ? /^spi_[a-f0-9]{32}$/ : /^job_[a-f0-9]{32}$/).test(id)) throw new MovieHttpError(400, "ジョブIDが不正です。");
  return base(owner) + kind + "/" + id + "/";
};
function endpoint(kind: Kind) {
  const id = process.env[kind === "image" ? "RUNPOD_TOONOUT_ENDPOINT_ID" : "RUNPOD_VOICE_ENDPOINT_ID"];
  if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !process.env.RUNPOD_API_KEY || !process.env.MOVIE_S3_BUCKET) {
    throw new MovieHttpError(503, "Serverlessの接続設定が完了していません。");
  }
  return id;
}
async function runpod(id: string, path: string, body?: unknown) {
  if (!process.env.RUNPOD_API_KEY) throw new MovieHttpError(503, "Runpodの接続設定が必要です。");
  const response = await fetch("https://api.runpod.ai/v2/" + id + "/" + path, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: { Authorization: "Bearer " + process.env.RUNPOD_API_KEY, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && response.status !== 408) throw new RunpodRejected(503, "Runpodに処理を受け付けてもらえませんでした。接続設定や残高を確認してください。");
    throw new MovieHttpError(503, "Runpodに接続できませんでした。");
  }
  return await response.json() as { id?: string; status?: string };
}
async function optional<T>(key: string) {
  try { return (await readJson<T>(key)).value; }
  catch (error) { if (error instanceof MovieHttpError && error.status === 404) return undefined; throw error; }
}
export async function serviceResponse(work: () => Promise<Response>) {
  try { return await work(); }
  catch (error) {
    return json({ error: error instanceof MovieHttpError ? error.message : "処理サーバーに接続できません。時間をおいて再試行してください。" },
      error instanceof MovieHttpError ? error.status : 503);
  }
}
async function manifest(owner: string, kind: Kind, id: string) {
  const prefix = jobPrefix(owner, kind, id);
  const value = (await readJson<Manifest>(prefix + "manifest.json")).value;
  if (value.owner !== owner || value.kind !== kind || value.id !== id) throw new MovieHttpError(404, "ジョブが見つかりません。");
  if (value.expires <= now()) throw new MovieHttpError(410, "保存期限が終了しました。再生成してください。");
  return { value, prefix };
}
async function submit(owner: string, kind: Kind, payload: Record<string, unknown>, files: { body: Uint8Array; name: string; type: string }[], key: string = randomUUID()) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new MovieHttpError(400, "リクエストIDが不正です。");
  const endpointId = endpoint(kind);
  const fingerprint = hash(JSON.stringify({ payload, files: files.map(file => ({ name: file.name, type: file.type, hash: hash(file.body) })) }));
  const id = (kind === "training" ? "spi_" : "job_") + hash(owner + ":" + kind + ":" + key).slice(0, 32);
  const prefix = jobPrefix(owner, kind, id);
  const date = new Date().toISOString();
  const job: PublicJob = { id, status: "queued", error: null, created_at: date, updated_at: date,
    ...(kind === "training" ? { voice_id: String(payload.voice_id), phase: "queued", sample_count: files.length,
      message: "学習の順番を待っています。", progress: { current: 0, total: 3000, ratio: 0 }, result: null } : {}) };
  const value: Manifest = { version: 1, owner, kind, id, expires: now() + MOVIE_TTL, fingerprint,
    endpoint: endpointId, payload, job, files: files.map((file, index) => ({
      key: prefix + "inputs/" + index + "-" + hash(file.body), sha256: hash(file.body), name: file.name, type: file.type, bytes: file.body.length,
    })) };
  try { await putFile(prefix + "manifest.json", JSON.stringify(value), "application/json", { IfNoneMatch: "*" }); }
  catch (error) {
    if (!(error instanceof MovieHttpError) || error.status !== 409) throw error;
    const previous = (await manifest(owner, kind, id)).value;
    if (previous.fingerprint !== fingerprint) throw new MovieHttpError(409, "同じリクエストIDが別の内容に使われています。");
  }
  // Equal retries stage identical immutable inputs. Only one request claims dispatch.
  for (let i = 0; i < files.length; i++) await putFile(value.files[i].key, files[i].body, files[i].type);
  try { await putFile(prefix + "dispatch.json", JSON.stringify({ submitted_at: date }), "application/json", { IfNoneMatch: "*" }); }
  catch (error) {
    if (error instanceof MovieHttpError && error.status === 409) return (await getJob(owner, kind, id));
    throw error;
  }
  try {
    const receipt = await runpod(endpointId, "run", { input: { manifest_key: prefix + "manifest.json" },
      policy: { executionTimeout: kind === "training" ? 7200000 : 1800000, ttl: 21600000 } });
    if (typeof receipt.id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(receipt.id)) throw new Error("Invalid receipt");
    await putFile(prefix + "receipt.json", JSON.stringify({ runId: receipt.id }), "application/json");
  } catch (error) {
    if (error instanceof RunpodRejected) {
      const failed = { ...job, status: "failed", error: error.message };
      await putFile(prefix + "result.json", JSON.stringify(failed), "application/json");
      return failed;
    }
    // A lost acknowledgement may still mean accepted. Never resubmit automatically.
    // The running worker writes the receipt itself so later polls can recover.
  }
  return job;
}
export async function getJob(owner: string, kind: Kind, id: string): Promise<PublicJob> {
  const { value, prefix } = await manifest(owner, kind, id);
  let job = await optional<PublicJob>(prefix + "result.json") ?? await optional<PublicJob>(prefix + "progress.json") ?? value.job;
  if (!terminal.has(job.status)) {
    const receipt = await optional<{ runId: string }>(prefix + "receipt.json");
    if (receipt) {
      const remote = await runpod(value.endpoint, "status/" + encodeURIComponent(receipt.runId));
      if (["FAILED", "TIMED_OUT", "CANCELLED", "COMPLETED"].includes(remote.status ?? "")) {
        // Re-read after terminal control-plane status: the worker writes R2 before returning.
        job = await optional<PublicJob>(prefix + "result.json") ?? { ...job,
          status: remote.status === "CANCELLED" ? "cancelled" : "failed",
          error: remote.status === "CANCELLED" ? null : "処理が中断されました。再生成してください。", updated_at: new Date().toISOString() };
      } else if (remote.status === "IN_PROGRESS" && job.status === "queued") job = { ...job, status: "running" };
    }
    if (await optional(prefix + "cancel.json") && !terminal.has(job.status)) job = { ...job, status: "cancelling" };
  }
  if (kind === "training" && job.result) {
    const saved = await optional<{ id: string }>(prefix + "saved.json");
    // A deleted asset must not be advertised as available.
    if (saved && await optional("voice-assets/" + owner + "/" + saved.id + "/asset.json")) {
      job = { ...job, result: { ...job.result, saved: true, saved_asset_id: saved.id } };
    }
  }
  return job;
}
export async function serviceJob(owner: string, kind: Kind, id: string, method: string, content = false) {
  return serviceResponse(async () => {
    const job = await getJob(owner, kind, id);
    const { value, prefix } = await manifest(owner, kind, id);
    if (content) {
      if (job.status !== "completed") throw new MovieHttpError(409, "処理はまだ完了していません。");
      const filename = kind === "image" ? "result.png" : kind === "speech" ? "result.wav" : "result.speaker.safetensors";
      // Browser fetch() consumes these small results as blobs. Return same-origin
      // bytes so a private R2 bucket does not need a public CORS policy.
      const bytes = await readFile(prefix + filename, (kind === "speech" ? 64 : 16) * 1024 ** 2);
      return new Response(bytes, { headers: {
        "Content-Type": kind === "speech" ? "audio/wav" : kind === "image" ? "image/png" : "application/octet-stream",
        "Content-Length": String(bytes.length), "Content-Disposition": 'attachment; filename="' + filename + '"',
        "Cache-Control": "private, no-store",
      } });
    }
    if (method === "DELETE" && !terminal.has(job.status)) {
      await putFile(prefix + "cancel.json", "{}", "application/json");
      const receipt = await optional<{ runId: string }>(prefix + "receipt.json");
      if (receipt && job.status === "queued") {
        const cancelled = await runpod(value.endpoint, "cancel/" + encodeURIComponent(receipt.runId), {});
        if (cancelled.status === "CANCELLED") {
          const result = { ...job, status: "cancelled", updated_at: new Date().toISOString() };
          await putFile(prefix + "result.json", JSON.stringify(result), "application/json");
          return json(result);
        }
      }
      return json({ ...job, status: "cancelling" });
    }
    return json(job);
  });
}
export function voiceHealth() {
  return serviceResponse(async () => {
    await runpod(endpoint("speech"), "health");
    return json({ connected: true, model: "irodori-tts", backend: "runpod",
      speakerInversion: { ready: true, reason: null, min_samples: 5, max_samples: 20, max_steps: 3000, busy: false } });
  });
}
function assetPrefix(owner: string, id: string, persistent: boolean) {
  base(owner);
  if (!/^vasset_[a-f0-9]{32}$/.test(id)) throw new MovieHttpError(400, "音声アセットIDが不正です。");
  return (persistent ? "voice-assets/" + owner + "/" : base(owner) + "assets/") + id + "/";
}
export async function getVoiceAsset(owner: string, id: string) {
  for (const persistent of [true, false]) {
    const stored = await optional<StoredAsset>(assetPrefix(owner, id, persistent) + "asset.json");
    if (stored?.owner === owner && (!stored.asset.expires_at || Date.parse(stored.asset.expires_at) > Date.now())) return stored;
  }
  throw new MovieHttpError(404, "音声アセットが見つかりません。再保存してください。");
}
export async function listVoiceAssets(owner: string) {
  base(owner);
  const assets: VoiceAsset[] = [];
  for (const key of (await listKeys("voice-assets/" + owner + "/")).filter(key => key.endsWith("/asset.json"))) {
    const stored = await optional<StoredAsset>(key);
    if (stored?.owner === owner && stored.asset.kind === "speaker_embedding") assets.push(stored.asset);
  }
  return assets.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}
export async function latestVoiceBytes(owner: string) {
  const asset = (await listVoiceAssets(owner))[0];
  if (!asset) throw new MovieHttpError(400, "Voiceで声モデルを保存してください。");
  return readFile((await getVoiceAsset(owner, asset.id)).key, 10 * 1024 ** 2);
}
export async function removeVoiceAsset(owner: string, id: string) {
  await deletePrefix(assetPrefix(owner, id, true));
  await deletePrefix(assetPrefix(owner, id, false));
  return json({ deleted: true, voiceAssetId: id });
}
export async function createVoiceReference(owner: string, file: File) {
  if (file.size === 0 || file.size > 10 * 1024 ** 2) throw new MovieHttpError(400, "基準音声は10MB以下にしてください。");
  const id = "vasset_" + uuid();
  const prefix = assetPrefix(owner, id, false);
  const asset: VoiceAsset = { id, object: "voice_asset", name: "reference", kind: "reference_audio", filename: "reference.wav",
    bytes: file.size, created_at: new Date().toISOString(), expires_at: new Date((now() + MOVIE_TTL) * 1000).toISOString(), persistent: false };
  await putFile(prefix + "reference.wav", new Uint8Array(await file.arrayBuffer()), "audio/wav");
  await putFile(prefix + "asset.json", JSON.stringify({ owner, asset, key: prefix + "reference.wav" } satisfies StoredAsset), "application/json");
  return json({ voiceAssetId: id }, 201);
}
export async function saveTrainedVoice(owner: string, id: string, name: string) {
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new MovieHttpError(400, "保存名は1〜80文字で指定してください。");
  const job = await getJob(owner, "training", id);
  if (job.status !== "completed" || !job.result) throw new MovieHttpError(409, "学習はまだ完了していません。");
  const { prefix } = await manifest(owner, "training", id);
  // Deterministic asset id makes repeated Save requests safe.
  const assetId = "vasset_" + hash(owner + ":" + id).slice(0, 32);
  const target = assetPrefix(owner, assetId, true);
  const bytes = await readFile(prefix + "result.speaker.safetensors", 10 * 1024 ** 2);
  const asset: VoiceAsset = { id: assetId, object: "voice_asset", name, kind: "speaker_embedding", filename: "voice.speaker.safetensors",
    bytes: bytes.length, created_at: job.updated_at, expires_at: null, persistent: true };
  await putFile(target + "voice.speaker.safetensors", bytes, "application/octet-stream");
  await putFile(target + "asset.json", JSON.stringify({ owner, asset, key: target + "voice.speaker.safetensors" } satisfies StoredAsset), "application/json");
  await putFile(prefix + "saved.json", JSON.stringify({ id: assetId }), "application/json");
  return json(asset, 201);
}
export async function submitSpeech(owner: string, request: Request, body: { input: string; caption: string; speed: number; voice: string; voiceAssetId: string }) {
  // Named local aliases are not portable between ephemeral workers.
  if (!body.voiceAssetId && body.voice !== "none") throw new MovieHttpError(400, "保存済みのマイボイスを選択してください。");
  const files: { body: Uint8Array; name: string; type: string }[] = [];
  let assetKind: string | undefined;
  if (body.voiceAssetId) {
    const stored = await getVoiceAsset(owner, body.voiceAssetId);
    assetKind = stored.asset.kind;
    files.push({ body: await readFile(stored.key, 10 * 1024 ** 2), name: stored.asset.filename, type: "application/octet-stream" });
  }
  return json(await submit(owner, "speech", { input: body.input, caption: body.caption, speed: body.speed, asset_kind: assetKind }, files,
    request.headers.get("Idempotency-Key") ?? randomUUID()), 202);
}
export async function submitTraining(owner: string, request: Request, input: FormData) {
  const name = String(input.get("voice_id") ?? "").trim();
  const files = input.getAll("files").filter((value): value is File => value instanceof File);
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new MovieHttpError(400, "Voice名は1〜80文字で指定してください。");
  if (files.length < 5 || files.length > 20 || files.some(file => !file.size || file.size > 25 * 1024 ** 2) ||
      files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 ** 2) throw new MovieHttpError(400, "学習には5〜20件、各25MB以下、合計100MB以下の音声が必要です。");
  let texts: unknown, captions: unknown;
  try { texts = JSON.parse(String(input.get("texts"))); captions = JSON.parse(String(input.get("captions") ?? "[]")); }
  catch { throw new MovieHttpError(400, "学習の文章と声の指示が不正です。"); }
  if (!Array.isArray(texts) || texts.length !== files.length || texts.some(text => typeof text !== "string" || !text.trim() || text.length > 4096) ||
      !Array.isArray(captions) || (captions.length !== 0 && captions.length !== files.length) || captions.some(text => typeof text !== "string" || text.length > 1000)) {
    throw new MovieHttpError(400, "学習サンプルと文章の件数を確認してください。");
  }
  return json(await submit(owner, "training", { voice_id: name, texts, captions: captions.length ? captions : files.map(() => "") },
    await Promise.all(files.map(async (file, i) => ({ body: new Uint8Array(await file.arrayBuffer()), name: "sample-" + i + ".wav", type: "audio/wav" }))),
    request.headers.get("Idempotency-Key") ?? randomUUID()), 202);
}
export async function submitImage(owner: string, data: string, mimeType: string) {
  const bytes = Buffer.from(data, "base64");
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType) || !bytes.length || bytes.length > 12 * 1024 ** 2) throw new MovieHttpError(400, "背景除去する画像が不正です。");
  return submit(owner, "image", {}, [{ body: bytes, name: "input", type: mimeType }]);
}
export async function ensureToonoutConfigured() { await runpod(endpoint("image"), "health"); }
export async function readServiceForm(request: Request, limit: number) {
  const bytes = await limitedBody(request, limit);
  try {
    return await new Request(request.url, { method: "POST", headers: { "Content-Type": request.headers.get("content-type") ?? "" }, body: bytes }).formData();
  } catch { throw new MovieHttpError(400, "フォームの送信データが不正です。"); }
}
