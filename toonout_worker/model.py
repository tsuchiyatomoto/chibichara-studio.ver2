from io import BytesIO
from threading import Lock

import numpy as np
import torch
from huggingface_hub import hf_hub_download
from PIL import Image, ImageFilter, UnidentifiedImageError
from torchvision import transforms
from transformers import AutoModelForImageSegmentation

from . import config


def clean_state_dict(state):
    if isinstance(state, dict):
        for wrapper in ("model", "state_dict", "module"):
            if wrapper in state and isinstance(state[wrapper], dict):
                state = state[wrapper]
                break

    def clean(key):
        changed = True
        while changed:
            changed = False
            for prefix in ("module.", "_orig_mod."):
                if key.startswith(prefix):
                    key = key[len(prefix):]
                    changed = True
        return key

    return {clean(key): value for key, value in state.items()}


def defringe(image, erode_px=0, feather=0.5, color_fix=True):
    """Remove bright edge halos using the post-process verified by the demo."""
    image = image.convert("RGBA")
    rgb = image.convert("RGB")
    alpha = image.getchannel("A")
    if color_fix:
        alpha_values = np.asarray(alpha)
        eroded = alpha.filter(ImageFilter.MinFilter(3))
        ring = (alpha_values > 0) & (np.asarray(eroded) == 0)
        colors = np.array(rgb)
        inner_colors = np.asarray(rgb.filter(ImageFilter.MinFilter(3)))
        colors[ring] = inner_colors[ring]
        rgb = Image.fromarray(colors)
    if erode_px > 0:
        alpha = alpha.filter(ImageFilter.MinFilter(2 * erode_px + 1))
    if feather > 0:
        alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
    result = rgb.convert("RGBA")
    result.putalpha(alpha)
    return result


class ToonOut:
    def __init__(self):
        if config.DEVICE not in {"auto", "cpu", "cuda"}:
            raise ValueError("TOONOUT_DEVICE must be auto, cpu, or cuda.")
        if config.DEVICE == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("TOONOUT_DEVICE=cuda was requested, but CUDA is unavailable.")
        self.device = "cuda" if (
            config.DEVICE == "cuda"
            or (config.DEVICE == "auto" and torch.cuda.is_available())
        ) else "cpu"
        weights = hf_hub_download(
            repo_id=config.MODEL_REPO,
            filename=config.MODEL_FILE,
            revision=config.MODEL_REVISION,
        )
        model = AutoModelForImageSegmentation.from_pretrained(
            config.BASE_MODEL,
            revision=config.BASE_REVISION,
            trust_remote_code=True,
        )
        try:
            state = torch.load(weights, map_location="cpu", weights_only=True)
        except TypeError:
            state = torch.load(weights, map_location="cpu")
        missing, unexpected = model.load_state_dict(clean_state_dict(state), strict=False)
        if missing or unexpected:
            raise RuntimeError(
                f"ToonOut weights do not match BiRefNet: missing={len(missing)}, "
                f"unexpected={len(unexpected)}"
            )
        self.model = model.float().to(self.device).eval()
        self.transform = transforms.Compose([
            transforms.Resize((config.INFERENCE_SIZE, config.INFERENCE_SIZE)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        self.to_image = transforms.ToPILImage()
        self.lock = Lock()

    def remove(self, content):
        try:
            with Image.open(BytesIO(content)) as opened:
                if opened.width * opened.height > config.MAX_PIXELS:
                    raise ValueError("Image dimensions are too large.")
                image = opened.convert("RGB")
        except (UnidentifiedImageError, OSError) as exc:
            raise ValueError("The request body is not a supported image.") from exc
        tensor = self.transform(image).unsqueeze(0).to(self.device)
        with self.lock, torch.inference_mode():
            prediction = self.model(tensor)[-1].sigmoid().cpu()
        mask = self.to_image(prediction[0].squeeze()).resize(
            image.size, Image.Resampling.BILINEAR
        )
        result = image.copy()
        result.putalpha(mask)
        result = defringe(
            result,
            erode_px=config.ERODE,
            feather=config.FEATHER,
            color_fix=True,
        )
        output = BytesIO()
        result.save(output, "PNG", optimize=True)
        return output.getvalue()
