# Chibichara Studio

Next.js app for creating chibi avatars and synthesizing Japanese speech.

Movie supports uploading a two-audio-track MP4, utterance-level Japanese analysis,
Gemini expression analysis, Irodori resynthesis, and mixed MP4 export.
See [Movie setup](docs/movie-setup.md) and [requirements](docs/movie-requirements.md).

## Setup

Install dependencies:

```bash
npm.cmd install
```

Create `.env.local` from the example and set your OpenAI key, Google Cloud project, and credential path:

```env
OPENAI_API_KEY=your-openai-api-key
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=global
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_APPLICATION_CREDENTIALS=C:/path/to/service-account-key.json
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image
IRODORI_TTS_BASE_URL=http://127.0.0.1:8088
IRODORI_TTS_MODEL=irodori-tts
IRODORI_TTS_TIMEOUT_MS=900000
```

Run the dev server:

```bash
npm.cmd run dev
```

Open http://localhost:3000.

Avatar image generation also requires the local ToonOut background-removal
worker. Install it once, then keep it running alongside Next.js:

```powershell
npm.cmd run toonout:setup
npm.cmd run toonout:start
```

The first worker start downloads the pinned ToonOut and BiRefNet model files.
See [ToonOut setup](docs/toonout-setup.md) for CUDA/CPU selection and background
operation.

## Logs

Local service logs are grouped under `logs/` and excluded from Git:

| Directory | Contents |
| --- | --- |
| `logs/dev/` | Next.js development server stdout and stderr |
| `logs/tts/` | Irodori-TTS server stdout and stderr |
| `logs/movie/` | Movie worker stdout and stderr |
| `logs/toonout/` | ToonOut worker stdout and stderr |
| `logs/diagnostics/` | Diagnostic and verification script logs |

On Windows, start a service in the background with timestamped logs in its
directory:

```powershell
npm.cmd run dev:background
npm.cmd run tts:background
npm.cmd run movie:background
npm.cmd run toonout:background
```

These commands use the default ports (3000, 8088, 8090, and 8091), reject occupied
ports, and print the process ID and both log paths. Existing foreground commands
continue to write to the terminal. Direct diagnostic script output to
`logs/diagnostics/`. Keep `.out.log` and `.err.log` pairs together; old logs retain
their original filenames. Next.js manages its own internal log separately at
`.next/dev/logs/next-development.log`.

## Irodori-TTS

The Voice page calls the official OpenAI-compatible
[Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server) through the
server-side `/api/generate-speech` route. The inference URL and optional API key
are never sent to the browser.

On the current Windows development machine, the server is installed in the
sibling `Irodori-TTS-Server` directory. Start it in a separate terminal:

```powershell
npm.cmd run tts:start
```

Keep that terminal open while using the Voice page. Press `Ctrl+C` to stop the
server. The start script also disables the Hugging Face Xet transfer path that
can stall large model downloads on this Windows environment.

The start script sets Speaker Inversion to 3000 training steps. Override it with
`-SpeakerInversionSteps` when starting the server. Speech generation separately
uses 40 sampling steps with FP32 model and codec precision.

To stop a server that is already running in the background:

```powershell
npm.cmd run tts:stop
```

For a fresh machine, install Irodori-TTS-Server on port `8088` first:

```powershell
git clone https://github.com/Aratako/Irodori-TTS-Server.git
Set-Location Irodori-TTS-Server
uv sync --extra cu128
Copy-Item .env.example .env
uv run --no-sync python -m irodori_openai_tts --host 127.0.0.1 --port 8088
```

The official server requires Python 3.10 and `uv`. CUDA or ROCm is recommended
for practical inference. The first synthesis downloads and loads the configured
Hugging Face model. To use the current v4.1 checkpoint, set this in the
Irodori-TTS-Server `.env` before starting it:

```env
IRODORI_HF_CHECKPOINT=phasefield-audio/Irodori-TTS-v4.1-Anime
IRODORI_SPEAKER_INVERSION_MIN_SAMPLES=5
IRODORI_SILENTCIPHER_WATERMARK=false
```

If the inference server requires a bearer token, set the same token in both the
Irodori server's `IRODORI_API_KEY` and this app's `IRODORI_TTS_API_KEY`.

### Speaker Inversion

The Voice page can turn generated clips into a reusable
`.speaker.safetensors` voice:

1. Describe a new voice using attribute choices or a free-text description.
2. Generate five preset sentences. The first clip creates the new voice; clips
   two through five use that first WAV as their temporary reference.
3. Listen to all five clips and start training. The voice name is internal.
4. Follow the progress. The completed model automatically replaces the previously
   saved model and is also available to download.
5. After saving, the page automatically generates all five preview sentences
   with the trained voice and switches to the post-training audio. Failed
   sentences can be retried individually using their preview button.

The first generated clip is kept as a private temporary reference, so later samples
use the same speaker identity. Training runs in Irodori-TTS-Server and temporarily
pauses synthesis to avoid GPU-memory contention. When the Voice page observes a
completed job, it automatically saves the result to the browser session, replacing
the previous saved voice. Reopening the page also saves a restored completed job.
The Voice creation page never fetches saved voice assets to generate samples.
Clicking the generate button again creates a fresh five-clip batch from the
selected description. A separate retry action resumes a partial batch with its
existing temporary reference, only when the voice description is unchanged.
The browser talks only to server-side proxies, and each browser session receives
an owner-scoped asset ID.

The TTS server needs a full Irodori-TTS source checkout for the official training
script. A local uv git checkout is detected automatically, or set
`IRODORI_SPEAKER_INVERSION_TRAINING_ROOT` in the TTS server `.env`.

## Notes

- The image generation endpoint runs server-side at `/api/generate-image`.
- Production character and avatar generation always use OpenAI `gpt-image-2.5-sunburst` with `quality: high`; set `OPENAI_API_KEY` in the runtime environment. Client provider selection and `OPENAI_IMAGE_MODEL` cannot override the production model, and failures never fall back to Vertex AI. Development retains the provider selector and model override. The production UI preview uses OpenAI. Google Cloud credentials remain relevant for development Nano Banana 2 and Movie audio analysis.
- Every generated Avatar image is passed through the local ToonOut worker and returned to the UI as a transparent PNG. The image provider is not charged when the worker fails its preflight check. The opaque character source is retained only as an internal image-edit reference; displayed and pose-frame images are transparent. See [ToonOut setup](docs/toonout-setup.md).
- Avatar generation processes only new or changed selected poses in numerical order, one image request at a time: four frames per pose, up to twelve frames in one run. Each pose stores its generation instruction and provider so unchanged poses are reused, including after reload. Unselected poses are retained. The per-pose regenerate button can recreate a saved pose with unchanged settings. Each completed pose replaces its saved frames in IndexedDB (`chibichara-avatar`) before the next pose starts; an image generation error stops the run while preserving completed poses and older frames for unfinished poses. Retrying generates only the remaining changed poses. Images and editor settings are automatically restored on reload in the same browser and origin. Successful character regeneration clears old poses. Image snapshots are committed atomically, separately from editor settings and animation state.
- Vertex image API errors are logged to server stderr as JSON with `event: "vertex_image_api_error"`, the timestamp, request ID, model, location, attempt, HTTP status, and full response body supplied by the SDK. SDK retries are disabled so the body is retained; the app still makes up to six attempts with exponential backoff within a two-minute timeout. With `npm run dev:background`, these records are saved in `logs/dev/*.err.log`. Search for `vertex_image_api_error` to inspect every failed attempt, including failures followed by a successful retry.
- The speech generation proxy runs server-side at `/api/generate-speech`.
- Movie's 「音声解析の診断ログ」 panel shows Gemini audio request timings, original/trimmed clip bounds, attempts, and error responses, including failures followed by a successful retry. Each job retains `audio-analysis.jsonl`, available through an owner-scoped download; failed attempts also appear in `logs/movie/*.err.log` as `audio_analysis_request` when using `npm run movie:background`. Restart the Movie worker to enable recording for new requests. See [Movie diagnostics](docs/movie-setup.md#音声解析エラーの確認).
- Speaker Inversion uses a persistent TTS-side background job; closing the page does not stop it.
- Keep service account JSON files out of git. The `secrets/` directory and `.env.local` are ignored.
- `GEMINI_IMAGE_MODEL` defaults to `gemini-3.1-flash-image`.
