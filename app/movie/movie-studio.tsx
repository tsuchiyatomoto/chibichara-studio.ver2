"use client";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import SegmentEditor from "./segment-editor";
import AudioDiagnostics from "./audio-diagnostics";
import {
  Job,
  Health,
  ACTIVE,
  STATES,
  field,
  button,
  secondary,
  stamp,
  fileUrl,
  api,
  post,
} from "./movie-types";

export default function MovieStudio() {
  const [health, setHealth] = useState<Health | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [game, setGame] = useState(0);
  const [voice, setVoice] = useState(1);
  const [gameGain, setGameGain] = useState(1);
  const [voiceGain, setVoiceGain] = useState(1);
  const [glossary, setGlossary] = useState("");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [page, setPage] = useState(0);
  const pauseUpload = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const refreshList = useCallback(async () => {
    const result = await api<{ jobs: Job[] }>("jobs");
    setJobs(result.jobs);
  }, []);
  const select = useCallback((selected: Job) => {
    setJob(selected);
    setGame(selected.game_index ?? 0);
    setVoice(selected.voice_index ?? 1);
    setGameGain(selected.game_gain);
    setVoiceGain(selected.voice_gain);
    setConfirmed(selected.confirmed);
    setPage(0);
    localStorage.setItem("movie-current", selected.id);
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all([api<Health>("health"), api<{ jobs: Job[] }>("jobs")])
      .then(([status, list]) => {
        if (!live) return;
        setHealth(status);
        setJobs(list.jobs);
        const found = list.jobs.find(
          (j) => j.id === localStorage.getItem("movie-current"),
        );
        if (found) select(found);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    const timer = setInterval(() => {
      api<Health>("health")
        .then((h) => {
          if (live) setHealth(h);
        })
        .catch(() => {});
    }, 30000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [select]);
  const jobId = job?.id;
  const running = !!job && ACTIVE.has(job.state);
  useEffect(() => {
    if (!jobId || !running) return;
    let live = true;
    const timer = setInterval(() => {
      api<Job>(`jobs/${jobId}`)
        .then((updated) => {
          if (!live) return;
          setJob(updated);
          if (updated.state === "ready") {
            setGame(updated.game_index!);
            setVoice(updated.voice_index!);
          }
          if (!ACTIVE.has(updated.state)) void refreshList();
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    }, 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [jobId, running, refreshList]);
  async function action(fn: () => Promise<Job>) {
    setBusy(true);
    setError("");
    try {
      setJob(await fn());
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作に失敗しました。");
    } finally {
      setBusy(false);
    }
  }
  async function upload(file?: File) {
    if (!file) return;
    if (
      !file.name.toLowerCase().endsWith(".mp4") ||
      !file.size ||
      file.size > (health?.max_bytes ?? 20 * 1024 ** 3)
    ) {
      setError("上限容量以内のMP4を選択してください。");
      return;
    }
    setError("");
    setUploading(true);
    pauseUpload.current = false;
    try {
      const hash = await crypto.subtle.digest(
        "SHA-256",
        await new Blob([
          file.slice(0, 65536),
          file.slice(Math.max(0, file.size - 65536)),
        ]).arrayBuffer(),
      );
      const signature = `${file.size}:${Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, "0")).join("")}`;
      const saved = JSON.parse(
        localStorage.getItem("movie-upload") ?? "null",
      ) as { id: string; signature: string } | null;
      const existing =
        saved?.signature === signature
          ? await api<Job>(`jobs/${saved.id}`).catch(() => null)
          : null;
      let current =
        existing?.state === "uploading"
          ? existing
          : await post<Job>("uploads", { name: file.name, size: file.size });
      localStorage.setItem(
        "movie-upload",
        JSON.stringify({ id: current.id, signature }),
      );
      select(current);
      while (current.received < file.size && !pauseUpload.current) {
        const chunk = file.slice(
          current.received,
          current.received + (health?.chunk_bytes ?? 8 * 1024 ** 2),
        );
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const result = await api<{ received: number }>(
              `uploads/${current.id}?offset=${current.received}`,
              {
                method: "PUT",
                headers: { "Content-Type": "application/octet-stream" },
                body: chunk,
              },
            );
            current = { ...current, received: result.received };
            break;
          } catch (e) {
            if (attempt === 2) throw e;
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        setJob(current);
      }
      if (current.received === file.size) {
        setJob(await post<Job>(`uploads/${current.id}/complete`));
        localStorage.removeItem("movie-upload");
      }
      await refreshList();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "アップロードに失敗しました。同じファイルを選択して再開できます。",
      );
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }
  const locked = busy || running || uploading;
  const reviewCount =
    job?.segments.filter((s) => s.issue || s.status === "review").length ?? 0;
  const visible = (job?.segments ?? []).filter(
    (s) => !reviewOnly || s.issue || s.status === "review",
  );
  const hasPreview = !!job?.segments.some((s) => s.status === "done");
  return (
    <div
      className="min-h-screen bg-[#f6f7fb] text-[#171717]"
      onPlayCapture={(event) =>
        document
          .querySelectorAll<HTMLMediaElement>("audio, video")
          .forEach((el) => {
            if (el !== event.target) el.pause();
          })
      }
    >
      <header className="border-b border-black/10 bg-white">
        <div className="mx-auto flex h-24 max-w-7xl items-center gap-4 px-5 sm:px-8">
          <Image
            src="/favicon.png"
            alt=""
            width={64}
            height={64}
            className="rounded-md"
          />
          <p className="text-2xl font-semibold tracking-tight sm:text-4xl">
            chibichara studio
          </p>
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-6 px-5 py-8 sm:px-8">
        <section className="overflow-hidden rounded-2xl border border-black/10 bg-white shadow-sm">
          <div className="border-b-4 border-[#22d3ee] bg-[#fffdf5] px-6 py-7 sm:px-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="mb-1 text-xs font-black tracking-[0.2em] text-[#9b6b16]">
                  MOVIE STUDIO
                </p>
                <h1 className="text-3xl font-black">
                  実況を、あなたのキャラクターの声に。
                </h1>
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  ゲーム音はそのままに、発言ごとの感情や話し方を声に反映します。
                </p>
              </div>
              <span className="rounded-full bg-[#e6faff] px-4 py-2 text-sm font-bold text-[#0e7490]">
                60分まで · 実況者1人
              </span>
            </div>
          </div>
          <div className="space-y-5 p-6 sm:p-8">
            <div
              className={`rounded-xl px-4 py-3 text-sm ${health?.voice_available ? "bg-cyan-50 text-cyan-900" : "bg-amber-50 text-amber-900"}`}
            >
              {health?.voice_available ? (
                "Voiceで保存した最新の声を使用します。処理中は同じ声に固定されます。"
              ) : (
                <>
                  Voiceで声を学習・保存してから変換できます。{" "}
                  <Link className="font-bold underline" href="/voice">
                    Voiceを開く →
                  </Link>
                </>
              )}
              {health?.error && <p className="mt-1">{health.error}</p>}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-5 rounded-2xl border-2 border-dashed border-cyan-200 bg-cyan-50/40 p-6">
              <div>
                <p className="font-bold">2つの音声トラックがあるMP4を選択</p>
                <p className="mt-2 text-sm text-slate-500">
                  音声1：ゲーム音　／　音声2：実況音声
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  最大
                  {Math.round(
                    (health?.max_bytes ?? 20 * 1024 ** 3) / 1024 ** 3,
                  )}{" "}
                  GiB。中断時は同じファイルを選ぶと再開できます。
                </p>
              </div>
              <input
                ref={input}
                className="hidden"
                type="file"
                accept="video/mp4,.mp4"
                aria-label="MP4ファイル"
                onChange={(e) => void upload(e.target.files?.[0])}
              />
              <button
                className={button}
                disabled={uploading || busy || !health}
                onClick={() => input.current?.click()}
              >
                MP4を選択
              </button>
            </div>
          </div>
        </section>
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          >
            {error}
          </div>
        )}
        {job && (
          <section className="space-y-6 rounded-2xl border border-black/10 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <span className="text-xs font-bold text-cyan-700">
                  {STATES[job.state] ?? job.state}
                </span>
                <h2 className="mt-1 break-all text-xl font-bold">{job.name}</h2>
                <p className="mt-2 text-sm text-slate-500">
                  {job.media ? `${stamp(job.media.duration)} · ` : ""}
                  {(job.size / 1024 ** 2).toFixed(1)} MB
                </p>
              </div>
              {running && (
                <button
                  className={secondary}
                  disabled={busy || job.state === "cancelling"}
                  onClick={() =>
                    void action(() => post(`jobs/${job.id}/cancel`))
                  }
                >
                  処理を中止
                </button>
              )}
              {uploading && (
                <button
                  className={secondary}
                  onClick={() => {
                    pauseUpload.current = true;
                  }}
                >
                  アップロードを一時停止
                </button>
              )}
              {["failed", "cancelled"].includes(job.state) && (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void action(() => post(`jobs/${job.id}/resume`))
                  }
                >
                  未完了の工程から再開
                </button>
              )}
            </div>
            <div aria-live="polite">
              <p className="text-sm text-slate-600">{job.message}</p>
              {job.error && (
                <p className="mt-2 break-words rounded-lg bg-red-50 p-3 text-sm text-red-700">
                  {job.error}
                </p>
              )}
              {job.warning && (
                <p className="mt-2 text-sm text-amber-700">{job.warning}</p>
              )}
              {(running || job.state === "uploading") && (
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full bg-cyan-500 transition-all ${running && !job.progress ? "animate-pulse" : ""}`}
                    style={{
                      width: `${job.state === "uploading" ? (job.received / job.size) * 100 : Math.max(3, job.progress)}%`,
                    }}
                  />
                </div>
              )}
              {job.state === "uploading" && (
                <p className="mt-2 text-xs text-slate-500">
                  {((job.received / job.size) * 100).toFixed(1)}%
                  アップロード済み
                </p>
              )}
            </div>
            <AudioDiagnostics key={job.id} job={job} />
            {job.state === "ready" && job.media && (
              <div className="space-y-5">
                <div className="grid gap-6 md:grid-cols-2">
                  {[
                    { label: "ゲーム音声", value: game, set: setGame },
                    { label: "実況音声", value: voice, set: setVoice },
                  ].map((track) => (
                    <div
                      key={track.label}
                      className="space-y-3 rounded-xl bg-slate-50 p-4"
                    >
                      <label className="block text-sm font-bold">
                        {track.label}
                        <select
                          className={`${field} mt-2`}
                          value={track.value}
                          onChange={(e) => track.set(Number(e.target.value))}
                        >
                          {job.media!.audio.map((a, i) => (
                            <option key={a.index} value={a.index}>
                              音声トラック{i + 1}
                              {a.title ? ` · ${a.title}` : ""}（{a.channels}ch）
                            </option>
                          ))}
                        </select>
                      </label>
                      <audio
                        key={track.value}
                        controls
                        preload="none"
                        className="h-10 w-full"
                        src={fileUrl(job, `track-${track.value}.m4a`)}
                      />
                      <p className="text-xs text-slate-500">冒頭30秒の試聴</p>
                    </div>
                  ))}
                </div>
                <label className="block text-sm font-bold">
                  ゲーム用語・固有名詞（任意）
                  <input
                    className={`${field} mt-2`}
                    placeholder="キャラクター名、技名、ゲーム名など"
                    value={glossary}
                    maxLength={2000}
                    onChange={(e) => setGlossary(e.target.value)}
                  />
                </label>
                <p className="text-xs leading-6 text-slate-500">
                  ゲーム音側に実況が混ざっている場合、その声も完成動画に残ります。トラックを別々に試聴して確認してください。
                </p>
                <button
                  className={button}
                  disabled={
                    locked ||
                    !health?.voice_available ||
                    !health.gemini_configured ||
                    game === voice
                  }
                  onClick={() =>
                    void action(() =>
                      post(`jobs/${job.id}/analyze`, {
                        game_index: game,
                        voice_index: voice,
                        glossary,
                      }),
                    )
                  }
                >
                  解析してプレビューを作成
                </button>
              </div>
            )}
            {!!job.segments.length && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-6">
                  <div>
                    <h3 className="text-lg font-bold">発言ごとの確認</h3>
                    <p className="mt-1 text-sm text-slate-500">
                      {job.segments.length}発言 · 確認が必要な発言 {reviewCount}
                      件
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={reviewOnly}
                      onChange={(e) => {
                        setReviewOnly(e.target.checked);
                        setPage(0);
                      }}
                    />
                    要確認だけを表示
                  </label>
                </div>
                <div className="space-y-3">
                  {visible.slice(page * 15, (page + 1) * 15).map((s) => (
                    <SegmentEditor
                      key={`${job.id}:${s.id}:${s.revision}`}
                      job={job}
                      segment={s}
                      disabled={locked}
                      preview={job.preview_ids?.includes(s.id) ?? false}
                      onSave={(body, regen) =>
                        action(async () => {
                          const updated = await api<Job>(
                            `jobs/${job.id}/segments/${s.id}`,
                            {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify(body),
                            },
                          );
                          return regen
                            ? post<Job>(
                                `jobs/${job.id}/segments/${s.id}/regenerate`,
                              )
                            : updated;
                        })
                      }
                    />
                  ))}
                </div>
                {visible.length > 15 && (
                  <div className="flex items-center justify-center gap-4 text-sm">
                    <button
                      className={secondary}
                      disabled={page === 0}
                      onClick={() => setPage(page - 1)}
                    >
                      前へ
                    </button>
                    {page + 1}/{Math.ceil(visible.length / 15)}
                    <button
                      className={secondary}
                      disabled={(page + 1) * 15 >= visible.length}
                      onClick={() => setPage(page + 1)}
                    >
                      次へ
                    </button>
                  </div>
                )}
              </>
            )}
            {job.analyzed && !running && (
              <div className="space-y-5 rounded-xl bg-[#fffdf5] p-5">
                <p className="text-sm leading-6 text-slate-600">
                  元の細かな抑揚や息遣いは完全には一致しません。生成した声に異音がないか、通常の発言と感情のある発言を試聴してください。
                </p>
                <div className="grid gap-5 sm:grid-cols-2">
                  {[
                    { label: "ゲーム音量", value: gameGain, set: setGameGain },
                    { label: "実況音量", value: voiceGain, set: setVoiceGain },
                  ].map((gain) => (
                    <label key={gain.label} className="text-sm font-bold">
                      {gain.label} · {Math.round(gain.value * 100)}%
                      <input
                        className="mt-3 block w-full accent-cyan-600"
                        type="range"
                        min="0"
                        max="2"
                        step="0.05"
                        value={gain.value}
                        onChange={(e) => gain.set(Number(e.target.value))}
                      />
                    </label>
                  ))}
                </div>
                <label className="flex items-start gap-3 text-sm leading-6">
                  <input
                    className="mt-1 size-4 accent-cyan-600"
                    type="checkbox"
                    checked={confirmed}
                    disabled={!hasPreview}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  生成された声を試聴し、声質と音質を確認しました。
                </label>
                <button
                  className={button}
                  disabled={locked || !confirmed || !hasPreview}
                  onClick={() =>
                    void action(() =>
                      post(`jobs/${job.id}/convert`, {
                        confirmed,
                        game_gain: gameGain,
                        voice_gain: voiceGain,
                      }),
                    )
                  }
                >
                  {job.state === "completed"
                    ? "音量を反映して書き出す"
                    : "全体を変換・続行"}
                </button>
                <p className="text-xs text-slate-500">
                  要確認の発言は、編集または「この内容で確認済み」を選んでから続行してください。
                </p>
              </div>
            )}
            {job.state === "completed" && (
              <div className="space-y-4 border-t border-slate-100 pt-6">
                <video
                  key={job.updated}
                  controls
                  preload="metadata"
                  className="max-h-[540px] w-full rounded-xl bg-black"
                  src={fileUrl(
                    job,
                    job.media?.codec === "h264" ? "output.mp4" : "preview.mp4",
                  )}
                />
                <div className="flex flex-wrap gap-3">
                  <a
                    className={button}
                    href={fileUrl(job, "output.mp4")}
                    download="converted.mp4"
                  >
                    MP4をダウンロード
                  </a>
                  <a
                    className={secondary}
                    href={fileUrl(job, "commentary.wav")}
                    download="commentary.wav"
                  >
                    実況WAVをダウンロード
                  </a>
                </div>
                <p className="text-xs text-slate-500">
                  ゲーム音と変換後の実況をミックスして収録しています。
                </p>
              </div>
            )}
            <p className="text-xs leading-6 text-slate-400">
              処理は画面を閉じても続きます。ファイルは完了・中止後24時間、確認待ちは最終操作から24時間保存されます。
            </p>
          </section>
        )}
        {!!jobs.length && (
          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="mb-4 font-bold">最近の動画</h2>
            <div className="space-y-2">
              {jobs.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg bg-slate-50 px-4 py-3"
                >
                  <button
                    className="min-w-0 flex-1 text-left"
                    disabled={uploading}
                    onClick={async () => {
                      try {
                        select(await api<Job>(`jobs/${item.id}`));
                      } catch (e) {
                        setError(
                          e instanceof Error
                            ? e.message
                            : "動画を取得できませんでした。",
                        );
                      }
                    }}
                  >
                    <p className="truncate text-sm font-semibold">
                      {item.name}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {STATES[item.state] ?? item.state}
                    </p>
                  </button>
                  <button
                    className="px-2 py-1 text-xs text-slate-500 underline disabled:opacity-30"
                    disabled={ACTIVE.has(item.state) || busy || uploading}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api(`jobs/${item.id}`, { method: "DELETE" });
                        if (job?.id === item.id) setJob(null);
                        await refreshList();
                      } catch (e) {
                        setError(
                          e instanceof Error
                            ? e.message
                            : "削除できませんでした。",
                        );
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    削除
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
