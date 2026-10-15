"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { AvatarPlacement, MovieAvatarPose } from "./movie-types";
import styles from "./movie-player.module.css";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  playerRef: RefObject<HTMLElement | null>;
  poses: MovieAvatarPose[];
  placement: AvatarPlacement;
  seed: number;
  editing: boolean;
  onPlacementChange: (placement: AvatarPlacement) => void;
  onClose: () => void;
};

type VideoRect = { left: number; top: number; width: number; height: number };

const DEFAULT_PLACEMENT: AvatarPlacement = {
  x: 0.82,
  y: 0.72,
  scale: 0.42,
  rotation: 0,
  flip_x: false,
};

function pseudo(seed: number, index: number) {
  let value = (seed ^ Math.imul(index + 1, 0x45d9f3b)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

export default function MovieAvatarOverlay({
  videoRef,
  playerRef,
  poses,
  placement,
  seed,
  editing,
  onPlacementChange,
  onClose,
}: Props) {
  const [rect, setRect] = useState<VideoRect | null>(null);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const drag = useRef<{ pointer: number; x: number; y: number; startX: number; startY: number } | null>(null);

  const measure = useCallback(() => {
    const video = videoRef.current;
    const player = playerRef.current;
    if (!video || !player || !video.videoWidth || !video.videoHeight) return;
    const bounds = player.getBoundingClientRect();
    const mediaRatio = video.videoWidth / video.videoHeight;
    const boxRatio = bounds.width / bounds.height;
    const width = boxRatio > mediaRatio ? bounds.height * mediaRatio : bounds.width;
    const height = boxRatio > mediaRatio ? bounds.height : bounds.width / mediaRatio;
    setRect({
      left: (bounds.width - width) / 2,
      top: (bounds.height - height) / 2,
      width,
      height,
    });
  }, [playerRef, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    const player = playerRef.current;
    if (!video || !player) return;
    measure();
    video.addEventListener("loadedmetadata", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(player);
    return () => {
      video.removeEventListener("loadedmetadata", measure);
      observer.disconnect();
    };
  }, [measure, playerRef, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stopped = false;
    let callback = 0;
    const render = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      setTick(Math.floor(metadata.mediaTime * 10));
      if (!stopped) callback = video.requestVideoFrameCallback(render);
    };
    if ("requestVideoFrameCallback" in video) callback = video.requestVideoFrameCallback(render);
    const fallback = () => setTick(Math.floor(video.currentTime * 10));
    const play = () => setPlaying(true);
    const pause = () => setPlaying(false);
    video.addEventListener("timeupdate", fallback);
    video.addEventListener("seeked", fallback);
    video.addEventListener("play", play);
    video.addEventListener("pause", pause);
    return () => {
      stopped = true;
      if (callback && "cancelVideoFrameCallback" in video) video.cancelVideoFrameCallback(callback);
      video.removeEventListener("timeupdate", fallback);
      video.removeEventListener("seeked", fallback);
      video.removeEventListener("play", play);
      video.removeEventListener("pause", pause);
    };
  }, [videoRef]);

  const frame = useMemo(() => {
    if (!poses.length) return undefined;
    const seconds = tick / 10;
    // This placement preview has no synthesized commentary yet. Keep its pose
    // fixed; the exported movie switches on speech after a silence interval.
    const poseIndex = poses.length === 1 ? 0 : pseudo(seed, 0) % poses.length;
    const blinkCycle = 28 + (pseudo(seed + 17, Math.floor(seconds / 3)) % 18);
    const eyesClosed = tick > 0 && tick % blinkCycle <= 1;
    const mouthOpen = playing && tick % 5 >= 2;
    const frameIndex = (eyesClosed ? 2 : 0) + (mouthOpen ? 1 : 0);
    return poses[poseIndex]?.frames[frameIndex];
  }, [playing, poses, seed, tick]);

  if (!rect || !frame) return null;

  const update = (changes: Partial<AvatarPlacement>) => onPlacementChange({ ...placement, ...changes });
  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!editing) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: placement.x,
      startY: placement.y,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    update({
      x: Math.min(4, Math.max(-3, active.startX + (event.clientX - active.x) / rect.width)),
      y: Math.min(4, Math.max(-3, active.startY + (event.clientY - active.y) / rect.height)),
    });
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
  };

  return (
    <div className={styles.avatarLayer} aria-label="アバタープレビュー">
      {/* The source is a user-generated data URL or an authenticated job asset. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className={`${styles.avatarImage} ${editing ? styles.avatarEditing : ""}`}
        src={frame}
        alt="動画に重ねるアバター"
        draggable={false}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        style={{
          left: rect.left + placement.x * rect.width,
          top: rect.top + placement.y * rect.height,
          width: placement.scale * rect.height,
          transform: `translate(-50%, -50%) rotate(${placement.rotation}deg) scaleX(${placement.flip_x ? -1 : 1})`,
        }}
      />
      {editing && (
        <div className={styles.avatarControls} role="group" aria-label="アバター配置">
          <div className={styles.avatarControlsHeader}>
            <strong>アバター配置</strong>
            <button type="button" onClick={onClose} aria-label="配置編集を閉じる">完了</button>
          </div>
          <p>アバターをドラッグして移動できます。画面外にはみ出す配置も可能です。</p>
          <label>
            大きさ <span>{Math.round(placement.scale * 100)}%</span>
            <input type="range" min="0.1" max="1.8" step="0.01" value={placement.scale} onChange={(event) => update({ scale: Number(event.target.value) })} />
          </label>
          <label>
            回転 <span>{Math.round(placement.rotation)}°</span>
            <input type="range" min="-180" max="180" step="1" value={placement.rotation} onChange={(event) => update({ rotation: Number(event.target.value) })} />
          </label>
          <div className={styles.avatarControlActions}>
            <button type="button" aria-pressed={placement.flip_x} onClick={() => update({ flip_x: !placement.flip_x })}>左右を反転</button>
            <button type="button" onClick={() => onPlacementChange(DEFAULT_PLACEMENT)}>初期位置</button>
          </div>
        </div>
      )}
    </div>
  );
}

export { DEFAULT_PLACEMENT };
