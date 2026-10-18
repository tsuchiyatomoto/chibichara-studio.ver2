# Web application

This directory is the independent Next.js application for Render. It contains
all Node dependencies, configuration, UI, API proxies, public assets, and web
tests. Install and run it from this directory:

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

The repository-level `npm run dev`, `npm run build`, `npm run lint`, and
`npm run test:web` commands delegate to this application. There are no npm
workspaces or dependencies on Python source files.

Use this directory as Render's Root Directory. The build command is
`npm ci && npm run build`; the start command is `npm start`. The app still
requires the GPU services and remote URL/token configuration before deployment.

For local development, `scripts/start-next.mjs` reads existing worker tokens
from the repository's `.movie-data/` and `.toonout-data/` directories. Remote
deployments use explicit `MOVIE_WORKER_TOKEN` and `TOONOUT_WORKER_TOKEN`
environment variables. Keep API keys and credentials server-side.

Voice generation and Avatar background removal return `202` job responses.
The UI stores pending requests in IndexedDB, polls owner-scoped API proxies,
and downloads completed WAV/PNG results separately. See
[Job API and recovery](../docs/async-jobs.md).

The Playwright configurations live in `tests/`. Run browser tests from this
directory, for example:

```powershell
npx playwright test --config tests/playwright.avatar.config.ts
```
