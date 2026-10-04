import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

function isFile(path) {
  try {
    return Boolean(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

// Next gives inherited environment variables priority over .env.local. A stale
// Windows credential path from another workspace must not hide this project's
// valid credentials. Keep valid inherited settings and normal ADC unchanged.
let local;
try {
  local = parseEnv(readFileSync(".env.local", "utf8"));
} catch {
  // Let Next and the APIs report missing configuration normally.
}

const inherited = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (inherited && !isFile(inherited)) {
  if (isFile(local?.GOOGLE_APPLICATION_CREDENTIALS)) {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    console.info("Ignoring missing inherited Google credentials; using project environment settings.");
  }
}

// Keep runtime data outside the Next.js module graph. Reading this token in an
// API route makes Turbopack trace the whole data directory during builds.
if (!process.env.MOVIE_WORKER_TOKEN) {
  const dataRoot = process.env.MOVIE_DATA_DIR || local?.MOVIE_DATA_DIR || path.join(process.cwd(), ".movie-data");
  const tokenPath = path.join(dataRoot, "service.token");
  if (isFile(tokenPath)) {
    process.env.MOVIE_WORKER_TOKEN = readFileSync(tokenPath, "utf8").trim();
  }
}

await import("next/dist/bin/next");
