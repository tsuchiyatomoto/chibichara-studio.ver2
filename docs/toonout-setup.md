# ToonOut background removal

Avatar character and animation-frame images are passed through the local
[ToonOut model](https://huggingface.co/joelseytre/toonout) before they are
returned to the browser. The UI and saved pose frames use transparent PNGs.
Opaque source images are used only as internal image-to-image references so
later edits do not use a transparent reference. The canonical character source
is retained in the same IndexedDB session to support pose generation after a
page reload; it is never displayed as the Avatar result.

## Setup

From PowerShell in the project root:

```powershell
npm.cmd run toonout:setup
npm.cmd run toonout:start
```

The setup script uses CUDA 12.8 PyTorch when `nvidia-smi` is available and CPU
otherwise. It pins the currently available compatible pair PyTorch 2.11 and
torchvision 0.26. Force a variant when necessary:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local/setup-toonout.ps1 -Torch cpu
```

The source is in `gpu/toonout_worker/`; settings are read from
`gpu/.env.local`, and Next.js reads its endpoint/token from `web/.env.local`.
The virtual environment defaults to the sibling directory
`chibichara-studio.ver2-toonout-venv`, outside the repository so Turbopack does
not watch its large dependency tree. Set `TOONOUT_VENV_DIR` to override it.
Existing `.toonout-data/` remains at the repository root; set `TOONOUT_DATA_DIR`
in both services to change that location.

The first start downloads the pinned ToonOut weights and pinned BiRefNet base
model from Hugging Face. Keep the worker terminal open, then start Next.js in a
second terminal. Because the worker creates its shared token on first start,
restart Next.js if Next was already running.

For background operation with logs in `logs/toonout/`:

```powershell
npm.cmd run toonout:background
```

The default worker address is `http://127.0.0.1:8091`. Configure it with
`TOONOUT_WORKER_URL`. `TOONOUT_DEVICE` accepts `auto`, `cuda`, or `cpu`, and
`TOONOUT_INFERENCE_SIZE` defaults to `1024`.

The integration pins ToonOut revision
`cbf720eca394edcde66b861a8a8c20fbabe9c748` and BiRefNet revision
`e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4`. Override the corresponding
revision environment variables only after validating output quality.

## Request behavior

The Web application uses owner-scoped `/jobs` requests. Job creation returns
`202` without waiting for inference; short status requests and a separate PNG
download avoid RunPod's HTTP processing timeout. The Web preflight requires a
worker that advertises job support, so restart older workers before updating
the Web application. See [Job API and recovery](async-jobs.md).

`/api/generate-image` checks the local worker before calling the paid image
provider. If ToonOut is unavailable, generation stops with a setup error rather
than returning an opaque image. Input is limited to PNG, JPEG, or WebP and the
worker serializes inference so concurrent requests cannot duplicate GPU use.

The mask is resized to the original image dimensions and applied as alpha. The
same color-fringe correction used by the referenced demo is applied with zero
erosion and a 0.5 pixel feather by default.
