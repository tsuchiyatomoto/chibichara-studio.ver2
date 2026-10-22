import "server-only";
import { randomUUID, createHash } from "node:crypto";
import type { Job, MovieAvatar } from "../../movie/movie-types";
import { fetchIrodori } from "./irodori";
import { getScopedIrodoriHeaders } from "./voice-owner";
import { voiceServerlessEnabled, listVoiceAssets, latestVoiceBytes } from "./service-serverless";
import { CHUNK_BYTES, MOVIE_PREFIX, MOVIE_TTL, MovieHttpError, readJson, putFile, listKeys, deletePrefix, downloadUrl, limitedBody } from "./movie-storage";

type Manifest = { job: Job; owner: string; expires: number; chunks: string[]; runId?: string; submitted?: boolean; glossary?: string; voiceKey?: string };
const now = () => Date.now() / 1000;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
const maxBytes = () => Number(process.env.MOVIE_MAX_BYTES || 20 * 1024 ** 3);
const active = new Set(["queued", "validating", "analyzing", "synthesizing", "mixing", "cancelling"]);

async function inputObject(request: Request, limit: number) {
  const value = JSON.parse((await limitedBody(request, limit)).toString());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MovieHttpError(400, "送信データが不正です。");
  return value;
}

async function runpod(path: string, body?: unknown) {
  const endpoint = process.env.RUNPOD_MOVIE_ENDPOINT_ID;
  const token = process.env.RUNPOD_API_KEY;
  if (!endpoint || !/^[a-zA-Z0-9_-]+$/.test(endpoint) || !token) throw new MovieHttpError(503, "動画処理の接続設定が不足しています。");
  const response = await fetch(`https://api.runpod.ai/v2/${endpoint}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    console.warn("[movie/runpod] Request failed", { operation: path.split("/")[0], status: response.status });
    throw new MovieHttpError(503, "動画処理サービスに接続できませんでした。");
  }
  return response.json();
}

async function status(manifest: Manifest, prefix: string): Promise<Job> {
  // The result survives worker shutdown and Runpod's result retention window.
  try { return (await readJson<Job>(prefix + "result.json")).value; }
  catch (error) { if (!(error instanceof MovieHttpError) || error.status !== 404) throw error; }
  if (!manifest.runId && manifest.submitted) {
    try { manifest.runId = (await readJson<{ runId: string }>(prefix + "receipt.json")).value.runId; }
    catch (error) { if (!(error instanceof MovieHttpError) || error.status !== 404) throw error; }
  }
  if (!manifest.runId) return manifest.job;
  const result = await runpod(`status/${encodeURIComponent(manifest.runId)}`);
  if (result.status === "FAILED" || result.status === "TIMED_OUT") return { ...manifest.job, state: "failed", message: "動画処理に失敗しました。動画を再アップロードしてください。" };
  if (result.status === "CANCELLED") return { ...manifest.job, state: "cancelled", message: "中止しました。" };
  if (result.status === "COMPLETED") throw new MovieHttpError(503, "完成動画の保存を確認できません。時間をおいて再取得してください。");
  try {
    await readJson(prefix + "cancel.json");
    return { ...manifest.job, state: "cancelling", message: "実行中の工程が終了したら中止します。" };
  } catch (error) { if (!(error instanceof MovieHttpError) || error.status !== 404) throw error; }
  return { ...manifest.job, state: result.status === "IN_QUEUE" ? "queued" : "analyzing", message: result.status === "IN_QUEUE" ? "動画処理の順番を待っています。" : "動画を解析・変換しています。" };
}

function avatarBody(value: unknown): MovieAvatar {
  const avatar = value as MovieAvatar;
  const p = avatar?.placement;
  if (!p || ![[p.x, -3, 4], [p.y, -3, 4], [p.scale, .05, 3], [p.rotation, -180, 180]].every(([v, min, max]) => Number.isFinite(v) && v >= min && v <= max) || typeof p.flip_x !== "boolean" || !Array.isArray(avatar.poses) || !avatar.poses.length || avatar.poses.length > 3) throw new MovieHttpError(400, "アバター設定が不正です。");
  const names = new Set<string>();
  for (const pose of avatar.poses) {
    if (!pose || !/^[a-zA-Z0-9_-]{1,40}$/.test(pose.id) || typeof pose.label !== "string" || !pose.label.length || pose.label.length > 100 || !Array.isArray(pose.frames) || pose.frames.length !== 4) throw new MovieHttpError(400, "アバター設定が不正です。");
    for (const name of pose.frames) {
      if (!/^avatar-[0-2]-[0-3]\.png$/.test(name) || names.has(name)) throw new MovieHttpError(400, "アバター画像が不正です。");
      names.add(name);
    }
  }
  return { placement: p, poses: avatar.poses.map(({ id, label, frames }) => ({ id, label, frames })) };
}

export async function movieServerless(request: Request, parts: string[], owner: string) {
  try { return await dispatch(request, parts, owner); }
  catch (error) {
    if (error instanceof MovieHttpError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return json({ error: "送信データが不正です。" }, 400);
    return json({ error: "動画の一時保存先または処理サービスに接続できません。設定を確認してください。" }, 503);
  }
}

async function dispatch(request: Request, parts: string[], owner: string): Promise<Response> {
  const method = request.method;
  const scope = `${MOVIE_PREFIX}${owner}/`;
  if (method === "GET" && parts.join("/") === "health") {
    if (voiceServerlessEnabled()) {
      const assets = await listVoiceAssets(owner);
      return json({ backend: "runpod", voice_available: assets.length > 0, tts_ready: true, gemini_configured: true, max_bytes: maxBytes(), chunk_bytes: CHUNK_BYTES });
    }
    const response = await fetchIrodori("/v1/audio/speaker-assets", { headers: await getScopedIrodoriHeaders() });
    const assets = response.ok ? await response.json() : { data: [] };
    return json({ backend: "runpod", voice_available: !!assets.data?.length, tts_ready: response.ok, gemini_configured: true, max_bytes: maxBytes(), chunk_bytes: CHUNK_BYTES });
  }
  if (method === "GET" && parts.join("/") === "jobs") {
    const keys = (await listKeys(scope)).filter(k => k.endsWith("/manifest.json"));
    const jobs: Job[] = [];
    for (const key of keys) {
      const { value } = await readJson<Manifest>(key);
      if (value.expires > now()) jobs.push(await status(value, key.slice(0, -"manifest.json".length)));
    }
    return json({ jobs: jobs.sort((a, b) => b.updated - a.updated) });
  }
  if (method === "POST" && parts.join("/") === "uploads") {
    const body = await inputObject(request, 4096);
    if (typeof body.name !== "string" || body.name.length > 255 || !body.name.toLowerCase().endsWith(".mp4") || !Number.isSafeInteger(body.size) || body.size <= 0 || body.size > maxBytes()) throw new MovieHttpError(400, "上限容量以内のMP4を選択してください。");
    const id = randomUUID().replaceAll("-", "");
    const job: Job = { id, name: body.name, size: body.size, received: 0, state: "uploading", message: "動画をアップロードしてください。", progress: 0, updated: now(), segments: [], confirmed: false, game_gain: 1, voice_gain: 1 };
    await putFile(`${scope}${id}/manifest.json`, JSON.stringify({ job, owner, expires: now() + MOVIE_TTL, chunks: [] } satisfies Manifest), "application/json", { IfNoneMatch: "*" });
    return json(job, 201);
  }
  const [kind, id, action, name] = parts;
  if (!["jobs", "uploads"].includes(kind) || !/^[a-f0-9]{32}$/.test(id || "")) throw new MovieHttpError(404, "動画が見つかりません。");
  const prefix = `${scope}${id}/`;
  const key = prefix + "manifest.json";
  const { value: manifest, etag } = await readJson<Manifest>(key);
  if (manifest.owner !== owner) throw new MovieHttpError(404, "動画が見つかりません。");
  if (manifest.expires <= now()) throw new MovieHttpError(410, "動画の保存期限が終了しました。再アップロードしてください。");
  const job = manifest.job;
  const save = async () => {
    job.updated = now();
    await putFile(key, JSON.stringify(manifest), "application/json", { IfMatch: etag });
  };
  if (kind === "jobs" && !action && parts.length === 2 && method === "GET") return json(await status(manifest, prefix));
  if (kind === "jobs" && action === "files" && parts.length === 4 && method === "GET") {
    if (!/^(output\.mp4|preview\.mp4|commentary\.wav|avatar-[0-2]-[0-3]\.png)$/.test(name)) throw new MovieHttpError(404, "ファイルが見つかりません。");
    if (!name.startsWith("avatar-") && (await status(manifest, prefix)).state !== "completed") throw new MovieHttpError(409, "動画を処理しています。");
    return new Response(null, { status: 302, headers: { Location: await downloadUrl(prefix + (name === "preview.mp4" ? "output.mp4" : name), manifest.expires, name), "Cache-Control": "private, no-store" } });
  }
  if (kind === "jobs" && action === "cancel" && method === "POST") {
    const current = await status(manifest, prefix);
    if (!active.has(current.state)) return json(current);
    if (!manifest.runId) throw new MovieHttpError(409, "受付確認中です。時間をおいて再取得してください。");
    await putFile(prefix + "cancel.json", "{}", "application/json");
    // Running work stops through Engine.check, after in-flight TTS completes.
    // Cancelling a queued Runpod job also avoids an unnecessary cold start.
    if (current.state === "queued") await runpod(`cancel/${encodeURIComponent(manifest.runId)}`, {});
    return json({ ...job, state: "cancelling", message: "中止しています。" });
  }
  if (kind === "jobs" && !action && method === "DELETE") {
    if (active.has((await status(manifest, prefix)).state)) throw new MovieHttpError(409, "処理を中止してから削除してください。");
    await deletePrefix(prefix);
    return json({ deleted: true });
  }
  if (manifest.submitted) throw new MovieHttpError(409, "処理は送信済みです。再処理する場合は動画を再アップロードしてください。");
  if (kind === "uploads" && !action && method === "PUT") {
    const offset = Number(new URL(request.url).searchParams.get("offset"));
    const data = await limitedBody(request, CHUNK_BYTES);
    if (job.state !== "uploading" || !data.length || !Number.isSafeInteger(offset) || offset < 0 || offset + data.length > job.size) throw new MovieHttpError(400, "アップロード範囲が不正です。");
    const chunk = `${prefix}chunks/${offset}-${createHash("sha256").update(data).digest("hex")}`;
    if (offset < job.received && manifest.chunks.includes(chunk)) return json({ received: job.received });
    if (offset !== job.received) throw new MovieHttpError(409, "アップロード位置が一致しません。");
    await putFile(chunk, data, "application/octet-stream");
    manifest.chunks.push(chunk); job.received += data.length;
    await save(); return json({ received: job.received });
  }
  if (kind === "uploads" && action === "complete" && method === "POST") {
    if (job.received !== job.size) throw new MovieHttpError(409, "アップロードが完了していません。");
    job.state = "ready"; job.message = "変換を開始できます。動画形式は処理開始時に確認します。";
    await save(); return json(job);
  }
  if (kind === "jobs" && action === "avatar-assets" && method === "PUT" && parts.length === 4 && job.state === "ready") {
    if (!/^avatar-[0-2]-[0-3]\.png$/.test(name)) throw new MovieHttpError(400, "画像名が不正です。");
    const data = await limitedBody(request, 10 * 1024 ** 2);
    if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new MovieHttpError(400, "PNGを指定してください。");
    await putFile(prefix + name, data, "image/png"); return json({ uploaded: true });
  }
  if (kind === "jobs" && action === "avatar" && method === "POST" && job.state === "ready") {
    job.avatar = avatarBody(await inputObject(request, 16384));
    const keys = new Set(await listKeys(prefix));
    if (job.avatar.poses.some(p => p.frames.some(f => !keys.has(prefix + f)))) throw new MovieHttpError(400, "アバター画像が不足しています。");
    job.avatar.seed = parseInt(id.slice(0, 8), 16);
    await save(); return json(job);
  }
  if (kind === "jobs" && action === "analyze" && method === "POST" && job.state === "ready") {
    const body = await inputObject(request, 16384);
    if (typeof body.glossary !== "string" || body.glossary.length > 2000 || !job.avatar) throw new MovieHttpError(400, "動画の設定が不正です。");
    for (const gain of [body.game_gain ?? 1, body.voice_gain ?? 1]) {
      if (!Number.isFinite(gain) || gain < 0 || gain > 2) throw new MovieHttpError(400, "音量の設定が不正です。");
    }
    const voiceBytes = voiceServerlessEnabled() ? await latestVoiceBytes(owner) : await (async () => {
    const headers = await getScopedIrodoriHeaders();
    const assets = await fetchIrodori("/v1/audio/speaker-assets", { headers });
    if (!assets.ok) throw new MovieHttpError(503, "声モデルを取得できません。");
    const data = (await assets.json()).data as { id: string; created_at: number }[];
    const asset = data.sort((a, b) => b.created_at - a.created_at)[0];
    if (!asset || !/^vasset_[a-f0-9]{32}$/.test(asset.id)) throw new MovieHttpError(400, "Voiceで声モデルを保存してください。");
    const voice = await fetchIrodori(`/v1/audio/voice-assets/${asset.id}/content`, { headers });
    if (!voice.ok) throw new MovieHttpError(503, "声モデルを取得できません。");
    return limitedBody(new Request("http://internal", { method: "POST", body: voice.body, duplex: "half" } as RequestInit), 10 * 1024 ** 2);
    })();
    const voiceKey = prefix + `voice-${createHash("sha256").update(voiceBytes).digest("hex")}.safetensors`;
    await putFile(voiceKey, voiceBytes, "application/octet-stream");
    manifest.voiceKey = voiceKey;
    manifest.glossary = body.glossary;
    job.game_gain = body.game_gain ?? 1;
    job.voice_gain = body.voice_gain ?? 1;
    manifest.submitted = true; job.state = "queued"; job.message = "動画処理の順番を待っています。";
    await save(); // Conditional claim prevents double-clicks from running two GPU jobs.
    const claimed = await readJson<Manifest>(key);
    try {
      const submitted = await runpod("run", { input: { manifest_key: key }, policy: { executionTimeout: 7200000, ttl: 21600000 } });
      if (typeof submitted.id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(submitted.id)) throw new Error("Invalid job receipt.");
      manifest.runId = submitted.id;
      await putFile(key, JSON.stringify(manifest), "application/json", { IfMatch: claimed.etag });
    } catch {
      // Submission timeouts are ambiguous: never blindly submit again.
      throw new MovieHttpError(503, "処理の受付確認ができませんでした。再送せず、時間をおいて一覧を確認してください。");
    }
    return json(job, 202);
  }
  throw new MovieHttpError(409, "この状態では操作できません。再処理には動画を再アップロードしてください。");
}
