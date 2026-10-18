from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import torch

from irodori_tts.codec import DACVAECodec
from irodori_tts.text_normalization import normalize_text

EVENT_PREFIX = "IRODORI_SPEAKER_EVENT "


def _emit_event(**payload: Any) -> None:
    print(f"{EVENT_PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True)


def _resolve_device(value: str) -> str:
    raw = value.strip().lower()
    if raw not in {"", "auto"}:
        return value
    return "cuda" if torch.cuda.is_available() else "cpu"


def _resolve_dtype(value: str, device: str) -> torch.dtype:
    if value.strip().lower() == "bf16" and device != "cpu":
        return torch.bfloat16
    return torch.float32


def prepare_latents(args: argparse.Namespace) -> None:
    samples_path = Path(args.samples_json).expanduser().resolve()
    output_manifest = Path(args.output_manifest).expanduser().resolve()
    latent_dir = Path(args.latent_dir).expanduser().resolve()
    payload = json.loads(samples_path.read_text(encoding="utf-8"))
    samples = payload.get("samples")
    if not isinstance(samples, list) or not samples:
        raise ValueError("samples_json must contain a non-empty samples array.")

    device = _resolve_device(args.device)
    dtype = _resolve_dtype(args.precision, device)
    latent_dir.mkdir(parents=True, exist_ok=True)
    output_manifest.parent.mkdir(parents=True, exist_ok=True)
    _emit_event(phase="preparing", current=0, total=len(samples), message="Loading codec")
    codec = DACVAECodec.load(
        repo_id=args.codec_repo,
        device=device,
        dtype=dtype,
        deterministic_encode=True,
        deterministic_decode=True,
    )

    manifest_lines: list[str] = []
    for index, sample in enumerate(samples):
        if not isinstance(sample, dict):
            raise ValueError(f"Invalid sample at index {index}.")
        audio_path = Path(str(sample.get("audio_path", ""))).expanduser().resolve()
        text = normalize_text(str(sample.get("text", ""))).strip()
        caption = str(sample.get("caption", "")).strip()
        if not audio_path.is_file():
            raise FileNotFoundError(f"Sample audio was not found: {audio_path}")
        if not text:
            raise ValueError(f"Sample text is empty at index {index}.")

        latent = codec.encode_file(audio_path)
        if latent.ndim == 3 and latent.shape[0] == 1:
            latent = latent[0]
        if latent.ndim != 2:
            raise ValueError(f"Unexpected latent shape for sample {index}: {tuple(latent.shape)}")
        latent = latent.detach().cpu().float().contiguous()
        latent_path = latent_dir / f"sample_{index + 1:03d}.pt"
        torch.save(latent, latent_path)
        item: dict[str, Any] = {
            "text": text,
            "latent_path": os.path.relpath(latent_path, start=output_manifest.parent),
            "num_frames": int(latent.shape[0]),
            "speaker_id": str(payload.get("voice_id", "speaker")),
        }
        if caption:
            item["caption"] = caption
        manifest_lines.append(json.dumps(item, ensure_ascii=False))
        _emit_event(
            phase="preparing",
            current=index + 1,
            total=len(samples),
            message=f"Encoded sample {index + 1}/{len(samples)}",
        )

    temporary_manifest = output_manifest.with_suffix(output_manifest.suffix + ".tmp")
    temporary_manifest.write_text("\n".join(manifest_lines) + "\n", encoding="utf-8")
    temporary_manifest.replace(output_manifest)
    _emit_event(
        phase="preparing",
        current=len(samples),
        total=len(samples),
        message="Latent preparation completed",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare local Speaker Inversion samples.")
    parser.add_argument("--samples-json", required=True)
    parser.add_argument("--output-manifest", required=True)
    parser.add_argument("--latent-dir", required=True)
    parser.add_argument("--codec-repo", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--precision", choices=["fp32", "bf16"], default="fp32")
    args = parser.parse_args()
    prepare_latents(args)


if __name__ == "__main__":
    main()
