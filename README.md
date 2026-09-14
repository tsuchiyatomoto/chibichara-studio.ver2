# Chibichara Studio

Next.js app for creating chibi avatars and synthesizing Japanese speech.

## Setup

Install dependencies:

```bash
npm.cmd install
```

Create `.env.local` from the example and set your project and credential path:

```env
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
- The speech generation proxy runs server-side at `/api/generate-speech`.
- Speaker Inversion uses a persistent TTS-side background job; closing the page does not stop it.
- Keep service account JSON files out of git. The `secrets/` directory and `.env.local` are ignored.
- `GEMINI_IMAGE_MODEL` defaults to `gemini-3.1-flash-image`.
