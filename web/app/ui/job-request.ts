"use client";

export type PendingJob = {
  key: string;
  kind: "speech" | "image";
  requestId: string;
  recoverable?: boolean;
  delivered?: boolean;
  resultBlob?: Blob;
  body: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  job?: { id: string; status: string; error?: string | null };
};

let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("chibichara-generation-jobs", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("requests", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("生成状況の保存領域を開けませんでした。"));
  }).catch((error) => { database = undefined; throw error; });
  return database;
}

async function update(record: PendingJob, remove = false) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("requests", "readwrite");
    const store = transaction.objectStore("requests");
    if (remove) store.delete(record.key); else store.put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function pendingJobs(kind: PendingJob["kind"]): Promise<PendingJob[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("requests");
    const request = transaction.objectStore("requests").getAll();
    transaction.oncomplete = () => resolve((request.result as PendingJob[]).filter((record) => record.kind === kind && record.recoverable !== false));
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getOrCreate(kind: PendingJob["kind"], body: Record<string, unknown>) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)));
  const key = `${kind}:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const db = await openDatabase();
  return new Promise<PendingJob>((resolve, reject) => {
    const transaction = db.transaction("requests", "readwrite");
    const store = transaction.objectStore("requests");
    const request = store.get(key);
    let record: PendingJob;
    request.onsuccess = () => {
      record = request.result ?? { key, kind, body, requestId: crypto.randomUUID() };
      if (!request.result) store.put(record);
    };
    transaction.oncomplete = () => resolve(record);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function errorMessage(response: Response) {
  const body = await response.json().catch(() => ({})) as { error?: string; detail?: string };
  return [body.error, body.detail].filter(Boolean).join("\n") || `通信に失敗しました（${response.status}）。`;
}

function wait(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timeout = setTimeout(done, 1500);
    const abort = () => { clearTimeout(timeout); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function requestJobResult(
  kind: PendingJob["kind"], body: Record<string, unknown>, signal?: AbortSignal,
): Promise<Response> {
  const record = await getOrCreate(kind, body);
  if (kind === "speech" && record.delivered && record.resultBlob) return new Response(record.resultBlob);
  if (kind === "image" && record.delivered && record.metadata?.image) return Response.json(record.metadata);
  const shortSignal = () => AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
  if (!record.job) {
    record.recoverable = true;
    await update(record);
    const response = await fetch(kind === "speech" ? "/api/generate-speech" : "/api/generate-image", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": record.requestId },
      body: JSON.stringify(record.body), signal: kind === "speech" ? shortSignal() : signal,
    });
    if (!response.ok) {
      if (response.status < 500 || kind === "image") await update(record, true);
      else { record.recoverable = false; await update(record); }
      throw new Error(await errorMessage(response));
    }
    // Accept already-completed responses from older/local integrations.
    if (response.status !== 202) { await update(record, true); return response; }
    const metadata = await response.json() as Record<string, unknown>;
    const job = (kind === "speech" ? metadata : metadata.job) as PendingJob["job"];
    if (!job?.id || !/^job_[a-f0-9]{32}$/.test(job.id)) throw new Error("生成ジョブのIDが不正です。");
    record.job = job;
    record.metadata = metadata;
    await update(record);
  }
  const base = `/api/${kind === "speech" ? "speech" : "image"}-jobs/${record.job.id}`;
  let failures = 0;
  const started = Date.now();
  while (Date.now() - started < 30 * 60 * 1000) {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(base, { cache: "no-store", signal: shortSignal() });
    } catch (error) {
      signal?.throwIfAborted();
      if (++failures >= 4) throw error;
      await wait(signal); continue;
    }
    if (response.status >= 500 || response.status === 429) {
      if (++failures >= 4) throw new Error(await errorMessage(response));
      await wait(signal); continue;
    }
    if (!response.ok) {
      if (response.status === 404) await update(record, true);
      throw new Error(await errorMessage(response));
    }
    failures = 0;
    const job = await response.json() as NonNullable<PendingJob["job"]>;
    if (["failed", "cancelled"].includes(job.status)) {
      await update(record, true);
      throw new Error(job.error || "生成が中止されました。");
    }
    if (job.status === "completed") {
      const content = await fetch(`${base}/content`, { cache: "no-store", signal: shortSignal() });
      if (!content.ok) throw new Error(await errorMessage(content));
      const blob = await content.blob();
      if (!blob.size) throw new Error("生成結果が空でした。");
      let result = new Response(blob, { headers: { "Content-Type": blob.type } });
      if (kind === "image") {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length > 16 * 1024 * 1024 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) {
          throw new Error("背景除去サーバーが正しいPNGを返しませんでした。");
        }
        const image = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(new Blob([bytes], { type: "image/png" }));
        });
        record.metadata = { ...record.metadata, image };
        record.delivered = true;
        result = Response.json(record.metadata);
      } else {
        record.resultBlob = blob;
        record.delivered = true;
      }
      await update(record);
      return result;
    }
    await wait(signal);
  }
  throw new Error("生成はサーバーで継続しています。時間をおいて再試行すると進捗を再取得します。");
}

export async function acknowledgeImageJobs() {
  for (const record of await pendingJobs("image")) {
    if (record.delivered) await update(record, true);
  }
}

export async function acknowledgeSpeechJobs(matches: (record: PendingJob) => boolean) {
  for (const record of await pendingJobs("speech")) {
    if (record.delivered && matches(record)) await update(record, true);
  }
}

export async function cancelPendingJobs(kind: PendingJob["kind"]) {
  for (const record of await pendingJobs(kind)) {
    if (record.job) {
      const response = await fetch(`/api/${kind === "speech" ? "speech" : "image"}-jobs/${record.job.id}`, {
        method: "DELETE", signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok && response.status !== 404) throw new Error(await errorMessage(response));
    }
    await update(record, true);
  }
}
