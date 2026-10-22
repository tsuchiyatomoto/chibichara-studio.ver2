import { expect, test } from "@playwright/test";
import type { Job } from "../app/movie/movie-types";

const responses = [
  {
    name: "HTML 404",
    status: 404,
    contentType: "text/html",
    body: "<!DOCTYPE html><html><body>Not Found</body></html>",
  },
  {
    name: "HTML 502",
    status: 502,
    contentType: "text/html",
    body: "<!DOCTYPE html><html><body>Bad Gateway</body></html>",
  },
  {
    name: "malformed JSON",
    status: 200,
    contentType: "application/json",
    body: '{"status":',
  },
];

for (const { name, status, contentType, body } of responses) {
  test(`Movie explains an invalid response: ${name}`, async ({ page }) => {
    await page.route("**/api/movie/**", (route) =>
      route.fulfill({ status, contentType, body }),
    );
    await page.goto("http://localhost:3000/movie");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      `動画処理サーバーから正しい応答を取得できませんでした（HTTP ${status}）。ページを再読み込みして、もう一度お試しください。`,
    );
    await expect(page.getByRole("button", { name: "MP4を選択", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("MP4ファイル")).toBeDisabled();
  });
}

for (const field of ["error", "detail"]) {
  test(`Movie preserves the server's JSON ${field} message`, async ({ page }) => {
    const message = "動画処理サーバーに接続できません。";
    await page.route("**/api/movie/**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ [field]: message }),
      }),
    );
    await page.goto("http://localhost:3000/movie");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(message);
  });
}

const pollingJob: Job = {
  id: "poll-recovery", name: "test.mp4", size: 100, received: 100,
  state: "analyzing", message: "動画を解析・変換しています。", progress: 20,
  updated: 1, segments: [], confirmed: false, game_gain: 1, voice_gain: 1,
};
const pollingHealth = {
  backend: "runpod", voice_available: true, tts_ready: true, gemini_configured: true,
  max_bytes: 1024 ** 3, chunk_bytes: 8 * 1024 ** 2,
};

for (const state of ["completed", "failed"]) {
  test(`Movie clears a temporary polling error when the job becomes ${state}`, async ({ page }) => {
    let job: Job = { ...pollingJob };
    let polls = 0;
    const failure = "動画処理サービスに接続できませんでした。";
    const processingError = "動画形式を確認してください。";
    await page.addInitScript((id) => localStorage.setItem("movie-current", id), job.id);
    await page.route("**/api/movie/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace("/api/movie/", "");
      if (path === "health") return route.fulfill({ json: pollingHealth });
      if (path === "jobs") return route.fulfill({ json: { jobs: [job] } });
      if (path === `jobs/${job.id}`) {
        polls++;
        if (polls === 1) return route.fulfill({ status: 503, json: { error: failure } });
        job = { ...job, state, progress: state === "completed" ? 100 : 20,
          ...(state === "failed" ? { error: processingError } : {}) };
        return route.fulfill({ json: job });
      }
      return route.fulfill({ status: 404 });
    });
    await page.goto("/movie");
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText(failure, { timeout: 10_000 });
    await expect(alert).toContainText("進捗を再確認しています。再変換せずにお待ちください。");
    if (state === "completed") {
      await expect(page.getByRole("link", { name: "MP4をダウンロード" })).toBeVisible({ timeout: 10_000 });
      await expect(alert).toHaveCount(0);
    } else {
      await expect(alert).toHaveText(processingError, { timeout: 10_000 });
    }
    expect(polls).toBe(2);
  });
}

test("Movie keeps an action error when status polling succeeds", async ({ page }) => {
  let polls = 0;
  const failure = "中止の受付を確認できませんでした。";
  await page.addInitScript((id) => localStorage.setItem("movie-current", id), pollingJob.id);
  await page.route("**/api/movie/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/movie/", "");
    if (path === "health") return route.fulfill({ json: pollingHealth });
    if (path === "jobs") return route.fulfill({ json: { jobs: [pollingJob] } });
    if (path.endsWith("/cancel")) return route.fulfill({ status: 503, json: { error: failure } });
    if (path === `jobs/${pollingJob.id}`) {
      polls++;
      return route.fulfill({ json: pollingJob });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto("/movie");
  await page.getByRole("button", { name: "処理を中止", exact: true }).click();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toHaveText(failure);
  const before = polls;
  await expect.poll(() => polls, { timeout: 10_000 }).toBeGreaterThan(before);
  await expect(alert).toHaveText(failure);
});
