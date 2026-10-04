import json
import math
import os
import subprocess
import time

import numpy as np
import soundfile as sf


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
            "実況トラックが無音です。トラックの割り当てを確認してください。"
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
            start, end = round(seg["start"] * 48000), round(seg["end"] * 48000)
            if start < position:
                raise ValueError(
                    "発言が重なっています。開始・終了時刻を確認してください。"
                )
            silence(output, start - position)
            # Never copy source commentary into an export. Unknown and legacy
            # modes such as "original" fail closed to silence.
            if seg["mode"] != "tts":
                data = np.zeros(end - start, dtype="float32")
            else:
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


def mix(job, directory, check, attenuation=1.0):
    commentary = timeline(job, directory, check)
    temp = directory / "output.part.mp4"
    duration = job["media"]["duration"]
    origin = job["media"]["origin"]
    filters = f"[1:a]volume={job['game_gain']}[g];[2:a]volume={job['voice_gain']}[v];[g][v]amix=inputs=2:normalize=0:duration=longest,aresample=192000,alimiter=limit=0.84:level=0:latency=1,aresample=48000,volume={attenuation},apad[a]"
    ffmpeg(
        [
            "-copyts",
            "-itsoffset",
            str(-origin),
            "-i",
            directory / "input.mp4",
            "-i",
            directory / "game.wav",
            "-i",
            commentary,
            "-filter_complex",
            filters,
            "-map",
            f"0:{job['media']['video_index']}",
            "-map",
            "[a]",
            "-map_metadata",
            "-1",
            "-c:v",
            "copy",
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
        ],
        check,
    )
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
    if job["media"]["codec"] != "h264":
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
