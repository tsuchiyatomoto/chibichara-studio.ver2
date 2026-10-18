import json
import math
import os
import random
import subprocess
import time

import numpy as np
import soundfile as sf
from PIL import Image


POSE_SILENCE_SECONDS = 2.0
AVATAR_SCALE_SECONDS = 0.3
AVATAR_SCALE_PEAK = 1.1
AVATAR_SCALE_FPS = 30


class Cancelled(Exception):
    pass


def run(args, check=lambda: None, timeout=3600, stderr=False):
    """No shell, bounded output, cancellation waits for child termination."""
    import tempfile

    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(
            [str(x) for x in args],
            stdout=out,
            stderr=err,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        started = time.monotonic()
        try:
            while proc.poll() is None:
                check()
                if time.monotonic() - started > timeout:
                    raise RuntimeError("音声・動画処理がタイムアウトしました。")
                time.sleep(0.15)
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        err.seek(0)
        if proc.returncode:
            raise RuntimeError(
                "FFmpeg処理に失敗しました: "
                + err.read()[-1800:].decode("utf-8", errors="replace")
            )
        stream = err if stderr else out
        stream.seek(0)
        return stream.read()


def ffmpeg(args, check=lambda: None):
    return run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args], check
    )


def probe(path, check=lambda: None):
    return json.loads(
        run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
                path,
            ],
            check,
            120,
        )
    )


def inspect(path, check=lambda: None):
    info = probe(path, check)
    if "mp4" not in info["format"].get("format_name", "").split(","):
        raise ValueError("MP4形式の動画を選択してください。")
    video = next(
        (
            s
            for s in info["streams"]
            if s["codec_type"] == "video"
            and not s.get("disposition", {}).get("attached_pic")
        ),
        None,
    )
    audio = [s for s in info["streams"] if s["codec_type"] == "audio"]
    if video is None or len(audio) < 2:
        raise ValueError(
            "映像と独立した2本の音声トラックが必要です。ステレオの左右は2トラックではありません。"
        )
    duration = float(video.get("duration") or info["format"].get("duration", 0))
    if not math.isfinite(duration) or not 0 < duration <= 3600:
        raise ValueError("動画は60分以内にしてください。")
    if video["codec_name"] not in {"h264", "hevc", "av1", "mpeg4", "vp9"}:
        raise ValueError("この映像コーデックはMP4出力に対応していません。")
    return {
        "duration": duration,
        "origin": float(video.get("start_time", 0)),
        "video_index": video["index"],
        "codec": video["codec_name"],
        "width": video.get("width"),
        "height": video.get("height"),
        "audio": [
            {
                "index": a["index"],
                "codec": a["codec_name"],
                "channels": a.get("channels", 1),
                "start": float(a.get("start_time", 0)),
                "title": a.get("tags", {}).get("title", ""),
            }
            for a in audio
        ],
    }


def extract(path, target, index, origin, duration, check):
    # Preserve stream offset relative to video PTS; async inserts missing samples.
    ffmpeg(
        [
            "-copyts",
            "-i",
            path,
            "-map",
            f"0:{index}",
            "-vn",
            "-af",
            f"asetpts=PTS-({origin})/TB,aresample=48000:async=1:first_pts=0,apad",
            "-t",
            str(duration),
            "-ac",
            "2",
            "-ar",
            "48000",
            "-c:a",
            "pcm_s16le",
            target,
        ],
        check,
    )


def mono(source, target):
    samples, sr = sf.read(source, dtype="float32", always_2d=True)
    if len(samples) == 0:
        raise ValueError("音声が空です。")
    power = np.mean(samples**2, axis=0)
    mixed = samples.mean(axis=1)
    warning = None
    if np.mean(mixed**2) < max(power) * 0.1:
        mixed = samples[:, int(np.argmax(power))]
        warning = (
            "実況の左右で音の相殺を検出したため、音量の大きいチャンネルを使用しました。"
        )
    if np.max(np.abs(mixed)) < 0.0001:
        raise ValueError(
            "実況音声として使用するトラック2が無音です。"
        )
    sf.write(target, mixed, sr, subtype="PCM_16")
    return warning


def excerpt(source, target, start, end, check=lambda: None):
    ffmpeg(
        [
            "-ss",
            str(max(0, start)),
            "-i",
            source,
            "-t",
            str(end - start),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            target,
        ],
        check,
    )


def active_audio(path):
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    data = data.mean(axis=1)
    if not len(data) or not np.isfinite(data).all():
        raise ValueError("生成音声が空または不正です。")
    if np.mean(np.abs(data) >= 0.999) > 0.01:
        raise ValueError("生成音声にクリッピングがあります。")
    frame = max(1, int(sr * 0.01))
    rms = np.sqrt(
        np.mean(np.pad(data**2, (0, (-len(data)) % frame)).reshape(-1, frame), axis=1)
    )
    indices = np.flatnonzero(rms > max(0.001, float(rms.max()) * 0.04))
    if not len(indices):
        raise ValueError("生成音声に発声がありません。")
    begin = max(0, int(indices[0] * frame - 0.025 * sr))
    finish = min(len(data), int((indices[-1] + 1) * frame + 0.04 * sr))
    return data[begin:finish], sr


def atempo_filters(ratio):
    """Build pitch-preserving FFmpeg tempo stages for any positive ratio."""
    if not math.isfinite(ratio) or ratio <= 0:
        raise ValueError("音声の時間補正倍率が不正です。")
    factors = []
    while ratio > 2:
        factors.append(2.0)
        ratio /= 2
    while ratio < 0.5:
        factors.append(0.5)
        ratio /= 0.5
    factors.append(ratio)
    return ",".join(f"atempo={factor:.8f}" for factor in factors)


def fit_audio(source, target, seconds, check=lambda: None):
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("発言時間が不正です。")
    data, sr = active_audio(source)
    ratio = len(data) / sr / seconds
    trimmed = target.with_suffix(".trim.wav")
    sf.write(trimmed, data, sr, subtype="PCM_16")
    try:
        ffmpeg(
            [
                "-i",
                trimmed,
                "-af",
                f"{atempo_filters(ratio)},aresample=48000,afade=t=in:d=0.004,afade=t=out:st={max(0, seconds - 0.004):.6f}:d=0.004",
                "-c:a",
                "pcm_s16le",
                target,
            ],
            check,
        )
    finally:
        trimmed.unlink(missing_ok=True)
    result, rate = sf.read(target, dtype="float32")
    limit = round(seconds * rate)
    # atempo works in windows and can differ by a few samples. Match the
    # timeline's exact sample count after pitch-preserving duration correction.
    sf.write(
        target,
        np.pad(result[:limit], (0, max(0, limit - len(result)))),
        rate,
        subtype="PCM_16",
    )


def timeline(job, directory, check):
    """Write silence and utterances incrementally, so 60-minute PCM is not in RAM."""
    target = directory / "commentary.wav"
    source = directory / "commentary-source.wav"
    count = round(job["media"]["duration"] * 48000)
    position = 0
    with (
        sf.SoundFile(
            target, "w", samplerate=48000, channels=1, subtype="PCM_16"
        ) as output,
        sf.SoundFile(source) as original,
    ):
        for seg in job["segments"]:
            check()
            # Muted rows do not need a timeline reservation: the unwritten
            # span is already silence. Skipping them also lets an invalid or
            # overlapping review row fail closed without blocking valid speech.
            if seg["mode"] != "tts":
                continue
            start, end = round(seg["start"] * 48000), round(seg["end"] * 48000)
            if start < position:
                raise ValueError(
                    "発言が重なっています。開始・終了時刻を確認してください。"
                )
            silence(output, start - position)
            data, sr = sf.read(directory / f"seg-{seg['id']}.wav", dtype="float32")
            if sr != 48000 or len(data) != end - start:
                raise ValueError(
                    "発言の音声と配置時刻が一致しません。再生成してください。"
                )
            original.seek(start)
            reference = original.read(
                end - start, dtype="float32", always_2d=True
            ).mean(axis=1)
            before = math.sqrt(float(np.mean(reference**2)))
            after = math.sqrt(float(np.mean(data**2)))
            data = data * np.clip(before / max(after, 0.0001), 0.5, 2.0)
            output.write(data)
            position = end
        silence(output, max(0, count - position))
    return target


def silence(output, frames):
    while frames > 0:
        length = min(48000, frames)
        output.write(np.zeros(length, dtype="float32"))
        frames -= length


def avatar_animation(job, directory, commentary, check):
    """Create a deterministic 10 fps pose/mouth/blink sequence for FFmpeg."""
    avatar = job["avatar"]
    duration = float(job["media"]["duration"])
    fps = 10
    frame_count = max(1, math.ceil(duration * fps))
    levels = []
    with sf.SoundFile(commentary) as voice:
        block = round(voice.samplerate / fps)
        for _ in range(frame_count):
            check()
            samples = voice.read(block, dtype="float32", always_2d=True)
            levels.append(
                math.sqrt(float(np.mean(samples**2))) if len(samples) else 0.0
            )
    active = np.asarray([level for level in levels if level > 0.0001])
    threshold = max(
        0.0003,
        float(np.percentile(active, 25)) * 0.55 if active.size else 0.0003,
    )
    generator = random.Random(int(avatar.get("seed", 0)))
    poses = avatar["poses"]
    pose_index = generator.randrange(len(poses))
    silence_frames = 0
    has_spoken = False
    required_silence_frames = math.ceil(POSE_SILENCE_SECONDS * fps)
    next_blink = generator.randint(26, 48)
    blink_until = -1
    sequence = []
    events = []
    scale_events = []
    for index in range(frame_count):
        mouth_open = levels[index] >= threshold
        # Keep the current pose throughout speech and silence. Only a new
        # utterance after a long enough pause can select a different pose.
        if mouth_open and has_spoken and silence_frames >= required_silence_frames:
            scale_events.append({"start": index / fps})
            if len(poses) > 1:
                offset = generator.randrange(1, len(poses))
                pose_index = (pose_index + offset) % len(poses)
        if mouth_open:
            has_spoken = True
            silence_frames = 0
        else:
            silence_frames += 1
        if index >= next_blink:
            blink_until = index + 2
            next_blink = index + generator.randint(26, 48)
        eyes_closed = index < blink_until
        frame_index = (2 if eyes_closed else 0) + (1 if mouth_open else 0)
        name = poses[pose_index]["frames"][frame_index]
        sequence.append(name)
        start = index / fps
        end = min(duration, (index + 1) / fps)
        if events and events[-1]["asset"] == name:
            events[-1]["end"] = end
        else:
            events.append(
                dict(
                    start=start,
                    end=end,
                    pose=pose_index,
                    frame=frame_index,
                    asset=name,
                )
            )
    manifest = ["ffconcat version 1.0"]
    for index, name in enumerate(sequence):
        manifest.extend(
            [f"file '{name}'", f"duration {min(1 / fps, duration - index / fps):.6f}"]
        )
    manifest.append(f"file '{sequence[-1]}'")
    concat = directory / "avatar.ffconcat"
    concat.write_text("\n".join(manifest) + "\n", encoding="utf-8")
    (directory / "avatar-animation.json").write_text(
        json.dumps(
            {
                "version": 1,
                "fps": fps,
                "duration": duration,
                "threshold": threshold,
                "pose_silence_seconds": POSE_SILENCE_SECONDS,
                "scale_duration": AVATAR_SCALE_SECONDS,
                "scale_peak": AVATAR_SCALE_PEAK,
                "scale_fps": AVATAR_SCALE_FPS,
                "scale_events": scale_events,
                "events": events,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return concat


def avatar_scale_filter(job, directory, side, check):
    """Animate scale on a fixed transparent canvas, keeping the center stable."""
    animation = json.loads((directory / "avatar-animation.json").read_text(encoding="utf-8"))
    commands = [f"0.000000 scale@avatar w {side};"]
    duration = float(job["media"]["duration"])
    steps = round(AVATAR_SCALE_SECONDS * AVATAR_SCALE_FPS)
    for event in animation["scale_events"]:
        for step in range(1, steps + 1):
            time = event["start"] + step / AVATAR_SCALE_FPS
            if time >= duration:
                break
            # Reach 110% quickly (0.1s), then ease back to 100% (0.2s).
            progress = step / steps
            phase = min(3 * progress, 1.5 * (1 - progress))
            scale = 1 + (AVATAR_SCALE_PEAK - 1) * (1 - math.cos(math.pi * phase)) / 2
            width = max(2, 2 * round(side * scale / 2))
            commands.append(f"{time:.6f} scale@avatar w {width};")
    command_file = directory / "avatar-scale.cmd"
    command_file.write_text("\n".join(commands) + "\n", encoding="utf-8")
    # Padding must accommodate the largest sprite even while scaling, so that
    # rotation and overlay receive fixed dimensions and never clip the pulse.
    peak_side = max(2, 2 * math.ceil(side * AVATAR_SCALE_PEAK / 2))
    peak_height = 2
    for pose in job["avatar"]["poses"]:
        for name in pose["frames"]:
            check()
            with Image.open(directory / name) as image:
                peak_height = max(peak_height, 2 * math.ceil(peak_side * image.height / image.width / 2))
    # Escape both FFmpeg's option parser and its surrounding filter graph.
    # This includes Windows drive ':' and apostrophes/spaces in job paths.
    command_path = command_file.resolve().as_posix()
    for special_characters in ("\\':", "\\'[],;"):
        command_path = "".join(
            "\\" + character if character in special_characters else character
            for character in command_path
        )
    return (
        f"fps={AVATAR_SCALE_FPS},sendcmd=f={command_path},"
        f"scale@avatar=w={side}:h=-2:eval=frame:flags=lanczos,format=rgba,"
        f"pad={peak_side}:{peak_height}:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame,"
    )


def mix(job, directory, check, attenuation=1.0):
    commentary = timeline(job, directory, check)
    temp = directory / "output.part.mp4"
    duration = job["media"]["duration"]
    origin = job["media"]["origin"]
    audio_filters = f"[1:a]volume={job['game_gain']}[g];[2:a]volume={job['voice_gain']}[v];[g][v]amix=inputs=2:normalize=0:duration=longest,aresample=192000,alimiter=limit=0.84:level=0:latency=1,aresample=48000,volume={attenuation},apad[a]"
    command = [
            "-copyts",
            "-itsoffset",
            str(-origin),
            "-i",
            directory / "input.mp4",
            "-i",
            directory / "game.wav",
            "-i",
            commentary,
        ]
    if job.get("avatar"):
        concat = avatar_animation(job, directory, commentary, check)
        placement = job["avatar"]["placement"]
        side = max(2, round(job["media"]["height"] * placement["scale"] / 2) * 2)
        angle = math.radians(placement["rotation"])
        scale_filter = avatar_scale_filter(job, directory, side, check)
        avatar_filters = (
            f"[0:{job['media']['video_index']}]setpts=PTS-STARTPTS[base];"
            f"[3:v]{scale_filter}"
            + ("hflip," if placement["flip_x"] else "")
            + f"rotate={angle:.9f}:ow=rotw({angle:.9f}):oh=roth({angle:.9f}):c=none,setpts=PTS-STARTPTS[avatar];"
            f"[base][avatar]overlay=x='{placement['x']:.9f}*W-w/2':y='{placement['y']:.9f}*H-h/2':shortest=1:eof_action=repeat[outv]"
        )
        command.extend(
            [
                "-f", "concat", "-safe", "0", "-i", concat,
                "-filter_complex", audio_filters + ";" + avatar_filters,
                "-map", "[outv]",
                "-map", "[a]",
                "-map_metadata", "-1",
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "21",
                "-pix_fmt", "yuv420p",
            ]
        )
    else:
        command.extend(
            [
                "-filter_complex", audio_filters,
                "-map", f"0:{job['media']['video_index']}",
                "-map", "[a]",
                "-map_metadata", "-1",
                "-c:v", "copy",
            ]
        )
    command.extend(
        [
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ac",
            "2",
            "-disposition:a:0",
            "default",
            "-t",
            str(duration),
            "-movflags",
            "+faststart",
            temp,
        ]
    )
    ffmpeg(command, check)
    info = probe(temp, check)
    if (
        len([s for s in info["streams"] if s["codec_type"] == "audio"]) != 1
        or abs(float(info["format"]["duration"]) - duration) > 0.1
    ):
        raise ValueError("完成動画の長さまたは音声トラック構成が一致しません。")
    ffmpeg(["-i", temp, "-map", "0", "-f", "null", "-"], check)
    loudness = run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-i",
            temp,
            "-vn",
            "-af",
            "loudnorm=I=-16:TP=-1:LRA=11:print_format=json",
            "-f",
            "null",
            "-",
        ],
        check,
        stderr=True,
    ).decode("utf-8", errors="replace")
    import re

    result = re.search(r'\{\s*"input_i".*?\}', loudness, re.DOTALL)
    if not result:
        raise ValueError("完成音声のピークを測定できませんでした。")
    metrics = json.loads(result.group())
    (directory / "loudness.json").write_text(json.dumps(metrics), encoding="utf-8")
    peak = float(metrics["input_tp"])
    if peak > -1:
        if attenuation < 1:
            raise ValueError(
                "完成音声のピークが基準を超えています。音量を下げて再出力してください。"
            )
        return mix(job, directory, check, 10 ** ((-1.2 - peak) / 20))
    os.replace(temp, directory / "output.mp4")
    if not job.get("avatar") and job["media"]["codec"] != "h264":
        ffmpeg(
            [
                "-i",
                directory / "output.mp4",
                "-vf",
                "scale=w='min(1280,iw)':h=-2",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "26",
                "-c:a",
                "copy",
                "-movflags",
                "+faststart",
                directory / "preview.mp4",
            ],
            check,
        )
