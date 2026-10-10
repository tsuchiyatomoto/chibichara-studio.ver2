"use client";

import { useEffect, useState } from "react";
import { ACTIVE, api, fileUrl, Job, stamp } from "./movie-types";

type Entry = {
  request_id: string;
  timestamp: string;
  operation: string;
  window_start: number;
  window_end: number;
  audio_start: number;
  audio_end: number;
  audio_duration_seconds: number;
  audio_bytes: number;
  elapsed_ms?: number;
  timeout_ms: number;
  attempt: number;
  max_attempts: number;
  model: string;
  location: string;
  outcome: "started" | "succeeded" | "failed";
  error?: { type: string; code?: number; status?: string; message: string; body?: unknown };
};

type Diagnostics = { available: boolean; entries: Entry[]; truncated: boolean };
const outcomes = { started: "応答記録なし", succeeded: "API応答成功", failed: "失敗" };

export default function AudioDiagnostics({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  const [failuresOnly, setFailuresOnly] = useState(true);
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    const refresh = () => {
      api<Diagnostics>(`jobs/${job.id}/audio-diagnostics`)
        .then((result) => {
          if (live) { setData(result); setError(""); }
        })
        .catch((e) => { if (live) setError(e instanceof Error ? e.message : "ログを取得できませんでした。"); });
    };
    refresh();
    const timer = ACTIVE.has(job.state) ? setInterval(refresh, 5000) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [open, job.id, job.state, job.updated]);

  const entries = data?.entries.filter((entry) => !failuresOnly || entry.outcome === "failed") ?? [];
  return (
    <details
      className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-bold text-slate-700">音声解析の診断ログ</summary>
      <div className="mt-4 space-y-4">
        <p className="text-slate-600">失敗した音声区間とAPIの応答を確認できます。再試行で成功した場合も、途中の失敗は残ります。</p>
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {!data && !error && <p>ログを読み込んでいます。</p>}
        {data && !data.available && (
          <p>診断ログはまだありません。この機能の追加前に起きたエラーの詳細は記録されていません。解析を再開すると、新しいAPIリクエストから記録されます。</p>
        )}
        {data?.available && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={failuresOnly} onChange={(event) => setFailuresOnly(event.target.checked)} />
                失敗したリクエストだけ表示
              </label>
              <a href={fileUrl(job, "audio-analysis.jsonl")} download className="font-bold text-cyan-700 underline">
                診断ログをダウンロード
              </a>
            </div>
            <p className="text-xs text-slate-500">
              新しい順に表示します。所要時間は1回のAPI呼び出しにかかった時間です。
              {data.truncated && " 画面には直近100試行を表示しています。それ以前の記録はダウンロードできます。"}
            </p>
            {entries.length === 0 && <p>{failuresOnly ? "表示対象の記録にAPIリクエストの失敗はありません。" : "リクエストの記録はまだありません。"}</p>}
            <div className="max-h-[32rem] space-y-3 overflow-y-auto">
              {entries.map((entry) => (
                <article key={entry.request_id} className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex flex-wrap justify-between gap-2 font-bold">
                    <span>{stamp(entry.window_start)}〜{stamp(entry.window_end)} · {entry.operation === "speech_review" ? "発言の再確認" : "音声解析"}</span>
                    <span className={entry.outcome === "failed" ? "text-red-700" : "text-slate-600"}>
                      {outcomes[entry.outcome]}{entry.error?.code ? ` (${entry.error.code})` : ""}
                    </span>
                  </div>
                  <p>
                    試行 {entry.attempt}/{entry.max_attempts} · 所要時間 {entry.elapsed_ms == null ? "未確定" : `${(entry.elapsed_ms / 1000).toFixed(1)}秒`}
                    {` · 設定期限 ${entry.timeout_ms / 1000}秒`}
                  </p>
                  <p className="text-xs text-slate-500">
                    {new Date(entry.timestamp).toLocaleString("ja-JP")} · {entry.model} · {entry.location}
                  </p>
                  <p className="text-xs text-slate-500">
                    送信した音声: {stamp(entry.audio_start)}〜{stamp(entry.audio_end)}
                    {` (${entry.audio_duration_seconds.toFixed(3)}秒 / ${(entry.audio_bytes / 1024).toFixed(1)} KB)`}
                  </p>
                  {entry.outcome === "started" && <p>リクエスト開始後の応答が未記録です。処理中、またはワーカーが中断した可能性があります。</p>}
                  {entry.error && <p className="break-words text-red-700">{entry.error.status || entry.error.type}: {entry.error.message}</p>}
                  <details>
                    <summary className="cursor-pointer text-slate-600">{entry.error ? "エラー詳細を開く" : "リクエスト詳細を開く"}</summary>
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-3 text-xs">
                      {JSON.stringify(entry, null, 2)}
                    </pre>
                  </details>
                </article>
              ))}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
