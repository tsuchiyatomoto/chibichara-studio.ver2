"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadAvatarSession } from "../avatar/avatar-storage";
import { loadVoiceSession } from "../voice/voice-storage";
import MoviePlayer from "./movie-player";
import {
  ACTIVE,
  api,
  fileUrl,
  post,
  type AvatarPlacement,
  type Job,
  type Health,
  type MovieAvatarPose,
} from "./movie-types";
import { DEFAULT_PLACEMENT } from "./movie-avatar-overlay";

type StoredAvatarImages = {
  version: 1;
  avatarPoses: Array<{
    id: string;
    label: string;
    frames: [string, string, string, string];
  }>;
};

type StoredVoiceIdentity = {
  version: 1;
  speakerJob?: { result?: { saved?: boolean; saved_asset_id?: string | null } | null } | null;
};

export default function MovieStudio() {
  const [health, setHealth] = useState<Health | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState<{ jobId: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [gameGain, setGameGain] = useState(1);
  const [voiceGain, setVoiceGain] = useState(1);
  const [glossary, setGlossary] = useState("");
  const [savedAvatarPoses, setSavedAvatarPoses] = useState<MovieAvatarPose[]>([]);
  const [avatarReady, setAvatarReady] = useState(false);
  const [voiceReady, setVoiceReady] = useState(false);
  const [savedVoiceAssetId, setSavedVoiceAssetId] = useState<string | null>(null);
  const voiceAvailable = !!health?.voice_available && !!savedVoiceAssetId;
  const [avatarPlacement, setAvatarPlacement] = useState<AvatarPlacement>(DEFAULT_PLACEMENT);
  const pauseUpload = useRef(false);
  const [localMedia, setLocalMedia] = useState<{ jobId: string; url: string } | null>(null);
  useEffect(() => {
    let live = true;
    loadAvatarSession<StoredAvatarImages>("images")
      .then((images) => {
        if (!live || images?.version !== 1 || !Array.isArray(images.avatarPoses)) return;
        const poses = images.avatarPoses.filter((pose) =>
          typeof pose.id === "string" &&
          typeof pose.label === "string" &&
          Array.isArray(pose.frames) &&
          pose.frames.length === 4 &&
          pose.frames.every((frame) => typeof frame === "string" && frame.startsWith("data:image/png")),
        );
        setSavedAvatarPoses(poses);
      })
      .catch(() => {})
      .finally(() => { if (live) setAvatarReady(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true;
    loadVoiceSession<StoredVoiceIdentity>()
      .then((session) => {
        if (!live || session?.version !== 1) return;
        const result = session.speakerJob?.result;
        if (result?.saved && typeof result.saved_asset_id === "string" && result.saved_asset_id) {
          setSavedVoiceAssetId(result.saved_asset_id);
        }
      })
      .catch(() => {})
      .finally(() => { if (live) setVoiceReady(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    return () => { if (localMedia) URL.revokeObjectURL(localMedia.url); };
  }, [localMedia]);
  const refreshList = useCallback(async () => {
    const result = await api<{ jobs: Job[] }>("jobs");
    setJobs(result.jobs);
  }, []);
  const select = useCallback((selected: Job) => {
    setJob(selected);
    setLocalMedia(null);
    setError("");
    setPollError(null);
    setGlossary("");
    setGameGain(selected.game_gain);
    setVoiceGain(selected.voice_gain);
    const storedPlacement = localStorage.getItem(`movie-avatar-placement:${selected.id}`);
    try {
      setAvatarPlacement(selected.avatar?.placement ?? (storedPlacement ? JSON.parse(storedPlacement) as AvatarPlacement : DEFAULT_PLACEMENT));
    } catch {
      setAvatarPlacement(selected.avatar?.placement ?? DEFAULT_PLACEMENT);
    }
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
      })
      .finally(() => {
        if (live) setLoading(false);
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
  const autoConvert = useRef<string | null>(null);
  useEffect(() => {
    if (!job || !job.analyzed || !["preview_ready", "needs_review"].includes(job.state)) return;
    const version = `${job.id}:${job.updated}`;
    if (autoConvert.current === version) return;
    autoConvert.current = version;
    void (async () => {
      setBusy(true);
      setError("");
      try {
        setJob(await post(`jobs/${job.id}/convert`, {
          confirmed: true,
          game_gain: gameGain,
          voice_gain: voiceGain,
        }));
        await refreshList();
      } catch (e) {
        setError(e instanceof Error ? e.message : "変換を開始できませんでした。");
      } finally {
        setBusy(false);
      }
    })();
  }, [job, gameGain, voiceGain, refreshList]);
  useEffect(() => {
    if (!jobId || !running) return;
    const polledJobId = jobId;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const updated = await api<Job>(`jobs/${polledJobId}`, { signal: AbortSignal.timeout(30000) });
        if (!live) return;
        setJob(updated);
        setPollError(null);
        if (!ACTIVE.has(updated.state)) {
          void refreshList().catch(() => {});
          return;
        }
      } catch (e) {
        if (live) setPollError({
          jobId: polledJobId,
          message: `${e instanceof Error ? e.message : "進捗を取得できませんでした。"} 進捗を再確認しています。再変換せずにお待ちください。`,
        });
      }
      if (live) timer = setTimeout(poll, 2500);
    }
    timer = setTimeout(poll, 2500);
    return () => {
      live = false;
      clearTimeout(timer);
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
  function changeAvatarPlacement(placement: AvatarPlacement) {
    setAvatarPlacement(placement);
    if (job) localStorage.setItem(`movie-avatar-placement:${job.id}`, JSON.stringify(placement));
  }
  async function attachAvatar(current: Job) {
    const existing = current.avatar?.poses ?? [];
    const source = existing.length ? existing : savedAvatarPoses;
    if (!source.length) throw new Error("Avatarでアバターを生成・保存してからMovieを開始してください。");
    const poses: MovieAvatarPose[] = [];
    for (let poseIndex = 0; poseIndex < source.length; poseIndex++) {
      const pose = source[poseIndex];
      const frames: string[] = [];
      for (let frameIndex = 0; frameIndex < pose.frames.length; frameIndex++) {
        const name = existing.length ? pose.frames[frameIndex] : `avatar-${poseIndex}-${frameIndex}.png`;
        if (!existing.length) {
          const image = await fetch(pose.frames[frameIndex]);
          if (!image.ok) throw new Error("保存したアバター画像を読み込めませんでした。");
          await api(`jobs/${current.id}/avatar-assets/${name}`, {
            method: "PUT",
            headers: { "Content-Type": "image/png" },
            body: await image.blob(),
          });
        }
        frames.push(name);
      }
      // Avatar storage also has generation-only metadata such as `provider`.
      // Send only the fields accepted by the Movie job snapshot schema.
      poses.push({
        id: pose.id,
        label: pose.label,
        frames: frames as MovieAvatarPose["frames"],
      });
    }
    return post<Job>(`jobs/${current.id}/avatar`, {
      placement: avatarPlacement,
      poses,
    });
  }
  async function startAnalysis() {
    if (!job || busy || uploading || running || !avatarReady || !voiceReady) return;
    if (!voiceAvailable) {
      setError("Voiceでボイスモデルを生成・保存してからMovieを開始してください。");
      return;
    }
    await action(async () => {
      const prepared = await attachAvatar(job);
      return post(`jobs/${prepared.id}/analyze`, {
        game_index: prepared.media?.audio[0]?.index,
        voice_index: prepared.media?.audio[1]?.index,
        glossary,
        ...(health?.backend === "runpod" ? { game_gain: gameGain, voice_gain: voiceGain } : {}),
      });
    });
  }
  async function upload(file?: File) {
    if (!file || uploading || busy || running) return;
    if (!avatarReady || !voiceReady || !health) return;
    if (!voiceAvailable || !savedAvatarPoses.length) {
      setError("Voiceでボイスモデルを、Avatarでアバターを生成・保存してから動画を選択してください。");
      return;
    }
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
      setLocalMedia({ jobId: current.id, url: URL.createObjectURL(file) });
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
    }
  }
  async function selectJob(id: string) {
    setBusy(true);
    setError("");
    try {
      select(await api<Job>(`jobs/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "動画を取得できませんでした。");
    } finally {
      setBusy(false);
    }
  }
  async function deleteJob(id: string) {
    setBusy(true);
    setError("");
    try {
      await api(`jobs/${id}`, { method: "DELETE" });
      if (job?.id === id) {
        setJob(null);
        setLocalMedia(null);
        localStorage.removeItem("movie-current");
      }
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除できませんでした。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <MoviePlayer
      key={job?.id ?? "empty"}
      job={job}
      jobs={jobs}
      health={health ? { ...health, voice_available: voiceAvailable } : null}
      error={error || (pollError && pollError.jobId === jobId ? pollError.message : "")}
      busy={busy || loading || !avatarReady || !voiceReady}
      uploading={uploading}
      assetsReady={avatarReady && voiceReady}
      hasSavedAvatar={savedAvatarPoses.length > 0}
      localVideoUrl={localMedia?.jobId === job?.id ? localMedia?.url : undefined}
      avatarPoses={(job?.avatar?.poses ?? savedAvatarPoses).map((pose) => ({
        ...pose,
        frames: (job?.avatar ? pose.frames.map((frame) => fileUrl(job, frame)) : pose.frames) as MovieAvatarPose["frames"],
      }))}
      avatarPlacement={avatarPlacement}
      avatarSeed={job?.avatar?.seed ?? 71237}
      onAvatarPlacementChange={changeAvatarPlacement}
      onUpload={upload}
      onPauseUpload={() => { pauseUpload.current = true; }}
      onSelectJob={selectJob}
      onDeleteJob={deleteJob}
      onAnalyze={() => void startAnalysis()}
      onConvert={() => job && void action(() => post(`jobs/${job.id}/convert`, {
        confirmed: true, game_gain: gameGain, voice_gain: voiceGain,
      }))}
      onCancel={() => job && void action(() => post(`jobs/${job.id}/cancel`))}
      onResume={() => job && void action(() => post(`jobs/${job.id}/resume`))}
      settings={{
        gameGain, voiceGain, glossary,
        setGameGain, setVoiceGain, setGlossary,
      }}
    />
  );
}
