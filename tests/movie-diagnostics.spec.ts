import { expect, test } from "@playwright/test";

const job = {
  id: "diagnostics-test", name: "解析確認.mp4", state: "failed", size: 100,
  message: "処理を完了できませんでした。", error: "504 DEADLINE_EXCEEDED", updated: 1,
  progress: 0, confirmed: false, game_gain: 1, voice_gain: 1, segments: [],
};
const failed = {
  request_id: "failed-1", timestamp: "2026-10-09T14:07:16Z", operation: "events",
  window_start: 808.5, window_end: 838.3, audio_start: 810, audio_end: 836.708,
  audio_duration_seconds: 26.708, audio_bytes: 854700, elapsed_ms: 119200, timeout_ms: 120000,
  attempt: 2, max_attempts: 3, model: "gemini-2.5-flash", location: "global", outcome: "failed",
  error: { type: "ServerError", code: 504, status: "DEADLINE_EXCEEDED", message: "Deadline expired",
    body: { error: { code: 504, message: "Deadline expired", status: "DEADLINE_EXCEEDED" } },
    response_headers: { "x-request-id": "google-request-1" } },
};

test("failed audio requests expose timings and full diagnostics after a successful retry", async ({ page }) => {
  const entries = [{ ...failed, request_id: "success-3", outcome: "succeeded", attempt: 3, error: undefined }, failed];
  await page.addInitScript(() => localStorage.setItem("movie-current", "diagnostics-test"));
  await page.route("**/api/movie/**", (route) => route.fulfill({ json:
    route.request().url().endsWith("/health") ? { voice_available: true, tts_ready: true, gemini_configured: true }
      : route.request().url().endsWith("/audio-diagnostics") ? { available: true, entries, truncated: false }
        : { jobs: [job] },
  }));
  await page.goto("http://localhost:3000/movie");
  await page.getByRole("button", { name: "設定・詳細" }).click();
  await page.getByText("音声解析の診断ログ", { exact: true }).click();
  await expect(page.getByText("13:28.5〜13:58.3 · 音声解析", { exact: true })).toHaveCount(1);
  await expect(page.getByText("試行 2/3 · 所要時間 119.2秒 · 設定期限 120秒", { exact: true })).toBeVisible();
  await page.getByText("エラー詳細を開く", { exact: true }).click();
  await expect(page.locator("pre")).toContainText('"x-request-id": "google-request-1"');
  await expect(page.getByRole("link", { name: "診断ログをダウンロード" })).toHaveAttribute(
    "href", "/api/movie/jobs/diagnostics-test/files/audio-analysis.jsonl");
  await page.getByLabel("失敗したリクエストだけ表示").uncheck();
  await expect(page.getByText("API応答成功", { exact: true })).toBeVisible();
});

test("legacy failures explain that detailed records start with the next request", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("movie-current", "diagnostics-test"));
  await page.route("**/api/movie/**", (route) => route.fulfill({ json:
    route.request().url().endsWith("/health") ? { voice_available: true, tts_ready: true, gemini_configured: true }
      : route.request().url().endsWith("/audio-diagnostics") ? { available: false, entries: [], truncated: false }
        : { jobs: [job] },
  }));
  await page.goto("http://localhost:3000/movie");
  await page.getByRole("button", { name: "設定・詳細" }).click();
  await page.getByText("音声解析の診断ログ", { exact: true }).click();
  await expect(page.getByText(/この機能の追加前に起きたエラーの詳細は記録されていません/)).toBeVisible();
  await expect(page.getByRole("link", { name: "診断ログをダウンロード" })).toHaveCount(0);
});
