import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const MOVIE_R2_RULE = {
  id: "chibichara-movie-delete-after-24h",
  enabled: true,
  conditions: { prefix: "movie-temp/" },
  deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
  abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } },
};

class R2ConfigurationError extends Error {}

function isMovieRule(rule) {
  return rule?.id === MOVIE_R2_RULE.id && rule.enabled === true &&
    rule.conditions?.prefix === "movie-temp/" &&
    rule.deleteObjectsTransition?.condition?.type === "Age" &&
    rule.deleteObjectsTransition.condition.maxAge === 86400 &&
    rule.abortMultipartUploadsTransition?.condition?.type === "Age" &&
    rule.abortMultipartUploadsTransition.condition.maxAge === 86400;
}

export async function configureMovieR2({ env = process.env, fetcher = fetch, apply = false } = {}) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  const bucket = env.MOVIE_S3_BUCKET;
  if (!/^[a-f0-9]{32}$/.test(account || "")) throw new R2ConfigurationError("Set CLOUDFLARE_ACCOUNT_ID to your Cloudflare account ID.");
  if (!token || token !== token.trim()) throw new R2ConfigurationError("Set CLOUDFLARE_API_TOKEN for R2 bucket configuration.");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || "")) throw new R2ConfigurationError("Set MOVIE_S3_BUCKET to the name of your existing R2 bucket.");

  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/lifecycle`;
  async function api(method = "GET", body) {
    const response = await fetcher(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new R2ConfigurationError(`R2 lifecycle ${method} failed (HTTP ${response.status}). Check the bucket name and token permissions.`);
    const data = await response.json();
    if (data.success !== true) throw new R2ConfigurationError("Cloudflare did not accept the lifecycle request.");
    return data.result;
  }

  const current = await api();
  if (!Array.isArray(current?.rules)) throw new R2ConfigurationError("Cloudflare returned an unexpected lifecycle configuration; no changes were made.");
  let configured = current.rules.some(isMovieRule);
  if (apply && !configured) {
    // Preserve existing rules, including the bucket's multipart cleanup rule.
    const rules = [...current.rules.filter(rule => rule.id !== MOVIE_R2_RULE.id), MOVIE_R2_RULE];
    await api("PUT", { rules });
    const verified = await api();
    configured = Array.isArray(verified?.rules) && verified.rules.some(isMovieRule);
    if (!configured) throw new R2ConfigurationError("The 24-hour deletion rule could not be verified after applying it.");
  }
  return { bucket, configured, prefix: "movie-temp/", deleteAfterSeconds: 86400 };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: npm run r2:check | npm run r2:configure\nUses CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and MOVIE_S3_BUCKET from the environment or web/.env.local. The bucket must already exist.");
    return;
  }
  if (args.some(arg => arg !== "--apply")) throw new R2ConfigurationError("Unknown argument. Use --help for usage.");
  const localEnv = fileURLToPath(new URL("../.env.local", import.meta.url));
  if (existsSync(localEnv)) process.loadEnvFile(localEnv);
  const result = await configureMovieR2({ apply: args.includes("--apply") });
  console.log(JSON.stringify(result, null, 2));
  if (!result.configured) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // Never print provider response bodies, URLs, request headers, or tokens.
    console.error(error instanceof R2ConfigurationError ? error.message : "Unable to configure R2. Check the connection and credentials.");
    process.exitCode = 1;
  });
}
