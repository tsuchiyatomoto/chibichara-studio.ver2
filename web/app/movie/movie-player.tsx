import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import AudioDiagnostics from "./audio-diagnostics";
import MovieAvatarOverlay from "./movie-avatar-overlay";
import { ACTIVE, STATES, fileUrl, stamp, type AvatarPlacement, type Health, type Job, type MovieAvatarPose } from "./movie-types";
import styles from "./movie-player.module.css";

type Settings = {
  gameGain: number;
  voiceGain: number;
  glossary: string;
  setGameGain: (value: number) => void;
  setVoiceGain: (value: number) => void;
  setGlossary: (value: string) => void;
};

type Props = {
  job: Job | null;
  jobs: Job[];
  health: Health | null;
  error: string;
  busy: boolean;
  uploading: boolean;
  localVideoUrl?: string;
  avatarPoses: MovieAvatarPose[];
  assetsReady: boolean;
  hasSavedAvatar: boolean;
  avatarPlacement: AvatarPlacement;
  avatarSeed: number;
  settings: Settings;
  onUpload: (file?: File) => Promise<void>;
  onPauseUpload: () => void;
  onSelectJob: (id: string) => Promise<void>;
  onDeleteJob: (id: string) => Promise<void>;
  onAnalyze: () => void;
  onConvert: () => void;
  onCancel: () => void;
  onResume: () => void;
  onAvatarPlacementChange: (placement: AvatarPlacement) => void;
};

function Icon({ name }: { name: "upload" | "history" | "settings" | "close" | "download" | "film" | "avatar" }) {
  const paths = {
    upload: <><path d="M12 16V4m-5 5 5-5 5 5" /><path d="M4 16v4h16v-4" /></>,
    history: <><path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7" /><path d="M12 7v5l3 2" /></>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 3v6m8 0v6M9 15v6" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    download: <><path d="M12 3v12m-5-5 5 5 5-5" /><path d="M4 17v4h16v-4" /></>,
    film: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M8 4v5m8-5v5" /><path d="m10 12 5 2.5-5 2.5Z" /></>,
    avatar: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.6-4.3 3-6.5 7-6.5s6.4 2.2 7 6.5" /><path d="M4 4h3M4 4v3m16-3h-3m3 0v3" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
  }, []);
  return (
    <div className={styles.overlay} role="dialog" aria-label={title} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }}>
      <div className={styles.overlayHeader}>
        <h2>{title}</h2>
        <button ref={close} className={styles.iconButton} onClick={onClose} aria-label="閉じる"><Icon name="close" /></button>
      </div>
      <div className={styles.overlayBody}>{children}</div>
    </div>
  );
}

export default function MoviePlayer({
  job, jobs, health, error, busy, uploading, localVideoUrl, avatarPoses, assetsReady, hasSavedAvatar, avatarPlacement, avatarSeed, settings,
  onUpload, onPauseUpload, onSelectJob, onDeleteJob, onAnalyze, onConvert, onCancel, onResume, onAvatarPlacementChange,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [panel, setPanel] = useState<"history" | "details" | null>(null);
  const [avatarEditing, setAvatarEditing] = useState(false);
  const panelTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!panel) panelTrigger.current?.focus();
  }, [panel]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const running = !!job && ACTIVE.has(job.state);
  const locked = busy || uploading || running;
  const checkingAssets = !health || !assetsReady;
  const missingVoice = !health?.voice_available;
  const missingAvatar = !hasSavedAvatar;
  const hasUploadAssets = !checkingAssets && !missingVoice && !missingAvatar;
  const canUpload = !locked && hasUploadAssets;
  const completed = job?.state === "completed";
  const serverless = health?.backend === "runpod";
  const reviewing = job?.state === "ready" && (!!job.media || serverless);
  const playable = completed || reviewing;
  const stopped = job && ["failed", "cancelled"].includes(job.state);
  const transitioning = job?.analyzed && !running && !stopped && !completed;
  const mutedCount = job?.segments.filter((s) => s.mode !== "tts").length ?? 0;
  const uploadPercent = job?.size ? Math.min(100, job.received / job.size * 100) : 0;
  const progress = job?.state === "uploading" ? uploadPercent : Math.min(100, Math.max(0, job?.progress ?? 0));
  const videoUrl = job ? completed
    ? `${fileUrl(job, job.avatar || job.media?.codec === "h264" ? "output.mp4" : "preview.mp4")}?v=${job.updated}`
    : localVideoUrl || (job.media ? fileUrl(job, "input.mp4") : undefined)
    : undefined;
  const voiceNotice = !health ? "接続を確認しています…" : !health.voice_available
    ? <Link href="/voice">Voiceで声を保存する →</Link>
    : "Voiceで保存した声を使用";
  const message = error || job?.error;
  const chooseFile = () => { if (canUpload && !panel) input.current?.click(); };

  return (
    <main className={styles.page}>
      <section
        ref={player}
        className={`${styles.player} ${dragging ? styles.dragging : ""}`}
        aria-label="Movie 動画ボックス"
        onPlayCapture={(event) => {
          event.currentTarget.querySelectorAll<HTMLMediaElement>("audio, video").forEach((el) => {
            if (el !== event.target) el.pause();
          });
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!event.dataTransfer.types.includes("Files")) return;
          dragDepth.current++;
          if (canUpload && !panel) setDragging(true);
        }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = !canUpload || panel ? "none" : "copy"; }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (canUpload && !panel) void onUpload(event.dataTransfer.files[0]);
        }}
      >
        {videoUrl && (
          <video
            ref={video}
            key={videoUrl}
            className={styles.video}
            src={videoUrl}
            controls={playable && !panel && !avatarEditing}
            muted={!playable}
            playsInline
            preload="metadata"
            aria-label={completed ? "完成動画" : "アップロードした動画"}
            inert={!!panel || !playable || avatarEditing}
          />
        )}
        {reviewing && avatarPoses.length > 0 && (
          <MovieAvatarOverlay
            videoRef={video}
            playerRef={player}
            poses={avatarPoses}
            placement={avatarPlacement}
            seed={avatarSeed}
            editing={avatarEditing}
            onPlacementChange={onAvatarPlacementChange}
            onClose={() => setAvatarEditing(false)}
          />
        )}
        <div
          className={`${styles.surface} ${completed ? styles.completed : ""} ${reviewing ? styles.reviewing : ""}`}
          inert={!!panel}
        >
          <header className={styles.header}>
            <div className={styles.identity}>
              <span className={styles.wordmark}><Icon name="film" /> MOVIE</span>
              {job && <h1 title={job.name}>{job.name}</h1>}
            </div>
            <div className={styles.tools}>
              {completed && job && (
                <a
                  className={styles.iconButton}
                  href={fileUrl(job, "output.mp4")}
                  download="converted.mp4"
                  aria-label="MP4をダウンロード"
                  title="MP4をダウンロード"
                ><Icon name="download" /></a>
              )}
              {reviewing && avatarPoses.length > 0 && (
                <button
                  className={`${styles.iconButton} ${avatarEditing ? styles.activeIconButton : ""}`}
                  onClick={() => setAvatarEditing((value) => !value)}
                  disabled={locked}
                  aria-label="アバターの配置を調整"
                  aria-pressed={avatarEditing}
                  title="アバターの配置を調整"
                ><Icon name="avatar" /></button>
              )}
              {reviewing && (
                <button
                  className={`${styles.primary} ${styles.headerAction}`}
                  disabled={locked || !health?.voice_available || !avatarPoses.length || !health.gemini_configured}
                  onClick={() => { setAvatarEditing(false); onAnalyze(); }}
                  title={!health?.voice_available
                    ? "Voiceで声を保存してください"
                    : !avatarPoses.length
                      ? "Avatarでアバターを生成・保存してください"
                      : !health.gemini_configured
                        ? "音声解析の接続設定が必要です"
                        : "確認した動画の変換を開始"}
                >
                  変換を開始
                </button>
              )}
              {job && <button className={styles.iconButton} onClick={chooseFile} disabled={!canUpload} aria-label="別のMP4を選択" title="別のMP4を選択"><Icon name="upload" /></button>}
              <button className={styles.iconButton} onClick={(event) => { panelTrigger.current = event.currentTarget; setPanel("history"); }} disabled={busy || uploading} aria-label="最近の動画" title="最近の動画"><Icon name="history" /></button>
              <button className={styles.iconButton} onClick={(event) => { panelTrigger.current = event.currentTarget; setPanel("details"); }} disabled={busy || uploading} aria-label="設定・詳細" title="設定・詳細"><Icon name="settings" /></button>
            </div>
          </header>
          <input ref={input} type="file" accept="video/mp4,.mp4" className={styles.fileInput} aria-label="MP4ファイル" disabled={!canUpload} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (canUpload && !panel) void onUpload(file);
          }} />
          {message && <p role="alert" className={styles.error}>{message}</p>}
          <div className={styles.body}>
            {(!job || job.state === "expired") && (
              <div className={styles.empty}>
                {checkingAssets ? (
                  <h1>Movieの準備を確認しています…</h1>
                ) : missingVoice || missingAvatar ? (
                  <>
                    <h1>{missingVoice && missingAvatar
                      ? "ボイスモデルとアバターを作成してください"
                      : missingVoice ? "ボイスモデルを作成してください" : "アバターを作成してください"}</h1>
                    <p>{missingVoice && missingAvatar
                      ? "Voiceでボイスモデルを、Avatarでポーズ付きアバターを生成・保存してください。"
                      : missingVoice
                        ? "Voiceでボイスモデルを生成・保存すると、Movieを開始できます。"
                        : "Avatarでポーズ付きアバターを生成・保存すると、Movieを開始できます。"}</p>
                    <div className={styles.preparationLinks}>
                      {missingVoice && <Link className={styles.primary} href="/voice">ボイスモデルを作成</Link>}
                      {missingAvatar && <Link className={missingVoice ? styles.secondary : styles.primary} href="/avatar">アバターを作成</Link>}
                    </div>
                  </>
                ) : (
                  <>
                    <span className={styles.uploadIcon}><Icon name="upload" /></span>
                    <h1>{job?.state === "expired" ? "動画の保存期限が終了しました" : "動画をここにドロップ"}</h1>
                    <p>あなたのキャラクターの声で、実況をつくる。</p>
                    <button className={styles.primary} disabled={!canUpload} onClick={chooseFile}>MP4を選択</button>
                    <small>ゲーム音と実況音が別トラックのMP4</small>
                  </>
                )}
              </div>
            )}
            {job && (running || job.state === "uploading") && (
              <div className={styles.center} aria-live="polite">
                <span className={styles.kicker}>{job.state === "uploading" ? "UPLOADING" : "PROCESSING"}</span>
                <h2>{job.state === "uploading" && !uploading ? "アップロードを再開" : STATES[job.state]}</h2>
                <p>{job.state === "uploading" ? uploading ? `${progress.toFixed(1)}% アップロード済み` : "同じMP4を選ぶと、続きからアップロードできます。" : job.message}</p>
                <div className={styles.progress} role="progressbar" aria-label="動画の処理状況" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                  <span className={running && !progress ? styles.indeterminate : ""} style={{ width: `${Math.max(3, progress)}%` }} />
                </div>
                {uploading ? <button className={styles.secondary} onClick={onPauseUpload}>アップロードを一時停止</button>
                  : job.state === "uploading" ? <button className={styles.primary} disabled={!canUpload} onClick={chooseFile}>同じMP4を選択して再開</button>
                    : <button className={styles.secondary} disabled={busy || job.state === "cancelling"} onClick={onCancel}>処理を中止</button>}
                {running && <small>画面を閉じても処理は続きます</small>}
              </div>
            )}
            {transitioning && (
              <div className={styles.center} aria-live="polite">
                <span className={styles.kicker}>PROCESSING</span>
                <h2>動画の変換を開始しています</h2>
                <p>解析結果を引き継いで、そのままキャラクターの声へ変換します。</p>
              </div>
            )}
            {stopped && job && (
              <div className={styles.center}>
                <span className={styles.kicker}>{job.state === "cancelled" ? "CANCELLED" : "PAUSED"}</span>
                <h2>{job.state === "cancelled" ? "処理を中止しました" : serverless ? "動画を処理できませんでした" : "処理を再開できます"}</h2>
                <p>{job.message}</p>
                {serverless
                  ? <button className={styles.primary} disabled={!canUpload} onClick={chooseFile}>MP4を選択してやり直す</button>
                  : <button className={styles.primary} disabled={busy} onClick={onResume}>未完了の工程から再開</button>}
              </div>
            )}
          </div>
          <footer className={styles.footer}>
            {completed && job ? <>
              <span className={styles.finished}>完成{mutedCount > 0 && <small> · {mutedCount}件を無音処理</small>}</span>
            </> : <>
              {!reviewing && <span>{voiceNotice}</span>}
              <span className={reviewing ? styles.footerDuration : undefined}>{job?.media ? stamp(job.media.duration) : "60分まで · 実況者1人"}</span>
            </>}
          </footer>
        </div>
        {dragging && canUpload && <div className={styles.dropOverlay}><Icon name="upload" /><p>ここにドロップしてアップロード</p></div>}
        {panel && <Overlay title={panel === "history" ? "最近の動画" : "設定・詳細"} onClose={() => setPanel(null)}>
          {message && <p role="alert" className={styles.error}>{message}</p>}
          {panel === "history" ? <>
            {!jobs.length && <p className={styles.hint}>{hasUploadAssets
              ? "まだ動画はありません。MP4を選んで始めてください。"
              : "まだ動画はありません。VoiceとAvatarで準備すると、動画を追加できます。"}</p>}
            <div className={styles.history}>
              {jobs.map((item) => <div key={item.id} className={styles.historyRow}>
                <button disabled={busy || uploading} onClick={async () => { await onSelectJob(item.id); setPanel(null); }} aria-current={item.id === job?.id ? "true" : undefined}>
                  <span>{item.name}</span><small>{STATES[item.state] ?? item.state}</small>
                </button>
                <button className={styles.deleteButton} disabled={ACTIVE.has(item.state) || busy || uploading} onClick={() => void onDeleteJob(item.id)} aria-label={`${item.name}を削除`}>削除</button>
              </div>)}
            </div>
            <p className={styles.hint}>動画は最終操作から24時間保存されます。処理中は削除されません。</p>
          </> : <div className={styles.settings}>
            <div><h3>使用する声</h3><p>{voiceNotice}</p>{health?.error && <p className={styles.notice}>{health.error}</p>}</div>
            {job?.state === "ready" && <label className={styles.label}>ゲーム用語・固有名詞（任意）<input value={settings.glossary} maxLength={2000} disabled={locked} placeholder="キャラクター名、技名、ゲーム名など" onChange={(event) => settings.setGlossary(event.target.value)} /></label>}
            {(serverless ? reviewing : job?.analyzed) && <>
              <div className={styles.gains}>
                {[{ label: "ゲーム音量", value: settings.gameGain, set: settings.setGameGain }, { label: "実況音量", value: settings.voiceGain, set: settings.setVoiceGain }].map((gain) => <label key={gain.label} className={styles.label}>{gain.label} · {Math.round(gain.value * 100)}%<input type="range" min="0" max="2" step="0.05" value={gain.value} disabled={locked} onChange={(event) => gain.set(Number(event.target.value))} /></label>)}
              </div>
              {completed ? <button className={styles.primary} disabled={locked} onClick={() => { onConvert(); setPanel(null); }}>音量を反映して書き出す</button> : <p className={styles.hint}>設定した音量は全体変換に反映されます。</p>}
            </>}
            {job && <>
              <div><h3>処理の詳細</h3><p className={styles.fileName}>{job.name}</p><p className={styles.hint}>{STATES[job.state] ?? job.state} · {(job.size / 1024 ** 2).toFixed(1)} MB{job.media && ` · ${stamp(job.media.duration)}`}</p>{job.warning && <p className={styles.notice}>{job.warning}</p>}{mutedCount > 0 && <p className={styles.hint}>{mutedCount}件を自動で無音処理しました。</p>}</div>
              {completed && <a className={styles.secondary} href={fileUrl(job, "commentary.wav")} download="commentary.wav"><Icon name="download" />実況WAVをダウンロード</a>}
              {!serverless && <AudioDiagnostics key={job.id} job={job} />}
            </>}
            <p className={styles.hint}>解析・生成で確認が必要な発言は、自動的に無音にして処理を続けます。</p>
            <p className={styles.hint}>MP4・最大{Math.round((health?.max_bytes ?? 20 * 1024 ** 3) / 1024 ** 3)} GiB・60分まで。ゲーム音と実況音を別々の音声トラックに収録してください。</p>
          </div>}
        </Overlay>}
      </section>
    </main>
  );
}
