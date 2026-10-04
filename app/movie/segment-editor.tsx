"use client";
import { useState } from "react";
import {
  Job,
  Segment,
  EMOTIONS,
  STYLES,
  VOCALIZATIONS,
  field,
  button,
  secondary,
  stamp,
  fileUrl,
} from "./movie-types";

export default function SegmentEditor({
  job,
  segment: s,
  disabled,
  preview,
  onSave,
}: {
  job: Job;
  segment: Segment;
  disabled: boolean;
  preview: boolean;
  onSave: (body: unknown, regenerate: boolean) => Promise<void>;
}) {
  const [text, setText] = useState(s.text);
  const [reading, setReading] = useState(s.reading);
  const [emotion, setEmotion] = useState(s.emotion);
  const [style, setStyle] = useState(s.style);
  const [start, setStart] = useState(String(s.start));
  const [end, setEnd] = useState(String(s.end));
  const [mode, setMode] = useState(s.mode === "tts" ? "tts" : "mute");
  const body = {
    revision: s.revision,
    text,
    reading,
    emotion,
    style,
    start: Number(start),
    end: Number(end),
    mode,
    accept: true,
  };
  return (
    <details
      className={`rounded-xl border ${s.issue ? "border-amber-200 bg-amber-50/50" : "border-slate-200 bg-white"}`}
      open={preview || undefined}
    >
      <summary className="cursor-pointer px-4 py-3 text-sm">
        <span className="mr-3 font-mono text-xs text-slate-500">
          {stamp(s.start)}–{stamp(s.end)}
        </span>
        <span className="font-bold">
          {s.text || VOCALIZATIONS[s.vocalization ?? ""] || "文字にならない発声"}
        </span>
        <span className="ml-3 text-xs text-slate-500">
          {EMOTIONS[s.emotion]} ·{" "}
          {s.issue
            ? "要確認"
            : s.mode !== "tts"
              ? "無音"
              : s.status === "done"
                ? "生成済み"
                : "未生成"}
        </span>
      </summary>
      <div className="space-y-4 px-4 pt-1 pb-5">
        {s.issue && (
          <p className="text-sm leading-6 text-amber-800">{s.issue}</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-bold text-slate-500">元の実況</p>
            <audio
              controls
              preload="none"
              className="h-10 w-full"
              src={fileUrl(job, `source-${s.id}.wav`)}
            />
          </div>
          <div>
            <p className="mb-2 text-xs font-bold text-slate-500">変換後の声</p>
            {s.status === "done" ? (
              <audio
                key={`${s.revision}:${s.status}`}
                controls
                preload="none"
                className="h-10 w-full"
                src={`${fileUrl(job, `seg-${s.id}.wav`)}?v=${s.revision}`}
              />
            ) : (
              <p className="py-2 text-sm text-slate-400">
                {s.mode === "tts" ? "生成後に試聴できます" : "変換対象外"}
              </p>
            )}
          </div>
        </div>
        {s.suggested_text && s.suggested_text !== s.text && (
          <p className="text-xs leading-6 text-slate-600">
            音声解析の候補：{s.suggested_text}{" "}
            <button
              className="font-bold text-cyan-700 underline"
              disabled={disabled}
              onClick={() => {
                setText(s.suggested_text!);
                setReading(s.suggested_text!);
              }}
            >
              候補を使用
            </button>
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs font-bold text-slate-600">
            発言の内容
            <textarea
              className={`${field} mt-2`}
              value={text}
              maxLength={1000}
              onChange={(e) => setText(e.target.value)}
              disabled={disabled}
            />
          </label>
          <label className="text-xs font-bold text-slate-600">
            読み・生成する台詞
            <textarea
              className={`${field} mt-2`}
              value={reading}
              maxLength={1000}
              onChange={(e) => setReading(e.target.value)}
              disabled={disabled}
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <label className="text-xs font-bold">
            開始（秒）
            <input
              className={`${field} mt-2`}
              type="number"
              min="0"
              step="0.01"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              disabled={disabled}
            />
          </label>
          <label className="text-xs font-bold">
            終了（秒）
            <input
              className={`${field} mt-2`}
              type="number"
              min="0"
              step="0.01"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              disabled={disabled}
            />
          </label>
          <label className="text-xs font-bold">
            感情
            <select
              className={`${field} mt-2`}
              value={emotion}
              onChange={(e) => setEmotion(e.target.value)}
              disabled={disabled}
            >
              {Object.entries(EMOTIONS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-bold">
            話し方
            <select
              className={`${field} mt-2`}
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              disabled={disabled}
            >
              {Object.entries(STYLES).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-bold">
            区間の扱い
            <select
              className={`${field} mt-2`}
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              disabled={disabled}
            >
              <option value="tts">声を変換</option>
              <option value="mute">無音にする</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            className={secondary}
            disabled={disabled}
            onClick={() => void onSave(body, false)}
          >
            この内容で確認済み
          </button>
          <button
            className={button}
            disabled={disabled || mode !== "tts"}
            onClick={() => void onSave(body, true)}
          >
            この発言を再生成
          </button>
        </div>
      </div>
    </details>
  );
}
