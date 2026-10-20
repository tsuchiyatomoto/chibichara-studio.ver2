export type Segment = {
  id: string;
  start: number;
  end: number;
  text: string;
  reading: string;
  emotion: string;
  style: string;
  mode: string;
  status: string;
  issue: string | null;
  suggested_text?: string;
  analysis_failed?: boolean;
  analysis_issue?: string | null;
  nonverbal?: boolean;
  vocalization?: string;
  fallback_reason?: string;
  revision: number;
};
export type AvatarPlacement = {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  flip_x: boolean;
};
export type MovieAvatarPose = {
  id: string;
  label: string;
  frames: [string, string, string, string];
};
export type MovieAvatar = {
  placement: AvatarPlacement;
  poses: MovieAvatarPose[];
  seed?: number;
};
export type Job = {
  id: string;
  name: string;
  size: number;
  received: number;
  state: string;
  message: string;
  error?: string;
  warning?: string;
  progress: number;
  updated: number;
  segments: Segment[];
  preview_ids?: string[];
  analyzed?: boolean;
  confirmed: boolean;
  game_index?: number;
  voice_index?: number;
  game_gain: number;
  voice_gain: number;
  media?: {
    codec: string;
    duration: number;
    audio: { index: number; title: string; channels: number }[];
  };
  voice?: { hash: string };
  avatar?: MovieAvatar;
};
export type Health = {
  backend?: "http" | "runpod";
  voice_available: boolean;
  tts_ready: boolean;
  gemini_configured: boolean;
  max_bytes: number;
  chunk_bytes: number;
  error?: string;
};
export const ACTIVE = new Set([
  "queued",
  "validating",
  "analyzing",
  "synthesizing",
  "mixing",
  "cancelling",
]);
export const STATES: Record<string, string> = {
  uploading: "アップロード",
  queued: "順番待ち",
  validating: "動画を確認中",
  ready: "解析準備完了",
  analyzing: "発言を解析中",
  synthesizing: "声を生成中",
  preview_ready: "変換を開始中",
  needs_review: "旧ジョブを自動処理",
  mixing: "MP4を書き出し中",
  completed: "完成",
  failed: "処理を停止",
  cancelled: "中止済み",
  cancelling: "中止しています",
};
export const EMOTIONS: Record<string, string> = {
  neutral: "通常",
  joy: "喜び",
  surprise: "驚き",
  anger: "怒り",
  fear: "不安",
  sadness: "落胆",
  confusion: "戸惑い",
  relief: "安心",
  unknown: "不明",
};
export const STYLES: Record<string, string> = {
  normal: "自然な会話",
  whisper: "囁き",
  shout: "叫び",
  laugh: "笑い混じり",
  cry: "泣き混じり",
  breathy: "息を含む",
  rushed: "早口",
};
export const VOCALIZATIONS: Record<string, string> = {
  laugh: "笑い声",
  scream: "悲鳴・叫び声",
  sigh: "ため息",
  cry: "泣き声",
  gasp: "息をのむ音",
  breath: "息遣い",
  cough: "咳・咳払い",
};
export const button =
  "rounded-xl bg-[#0891b2] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#0e7490] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600";
export const secondary =
  "rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40";
export const field =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-cyan-500";
export const stamp = (s: number) =>
  `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
export const fileUrl = (job: Job, name: string) =>
  `/api/movie/jobs/${job.id}/files/${name}`;
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/movie/${path}`, {
    cache: "no-store",
    ...init,
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      `動画処理サーバーから正しい応答を取得できませんでした（HTTP ${response.status}）。ページを再読み込みして、もう一度お試しください。`,
    );
  }
  if (!response.ok) {
    const error = data && typeof data === "object" ? data : {};
    const validation = "detail" in error && Array.isArray(error.detail)
      ? error.detail
        .map((item) => item && typeof item === "object" && "msg" in item ? String(item.msg) : "")
        .filter(Boolean)
        .join(" / ")
      : "";
    throw new Error(
      "error" in error && typeof error.error === "string"
        ? error.error
        : "detail" in error && typeof error.detail === "string"
          ? error.detail
          : validation
            ? `入力内容を確認してください: ${validation}`
          : "処理に失敗しました。入力内容とサーバーの状態を確認してください。",
    );
  }
  return data as T;
}
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
