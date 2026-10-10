import { expect, test } from "@playwright/test";

test("Movie labels a recognized vocalization without inserting spoken text", async ({ page }) => {
  const job = {
    id: "laugh-test", name: "笑い声.mp4", state: "needs_review", size: 100,
    message: "解析完了", updated: 1, progress: 100, analyzed: true,
    confirmed: false, game_gain: 1, voice_gain: 1,
    segments: [{
      id: "1", start: 3.612, end: 4.58, text: "", reading: "",
      emotion: "joy", style: "laugh", mode: "tts", status: "pending",
      issue: null, nonverbal: true, vocalization: "laugh", revision: 0,
    }],
  };
  await page.addInitScript(() => localStorage.setItem("movie-current", "laugh-test"));
  await page.route("**/api/movie/**", (route) => route.fulfill({
    json: route.request().url().endsWith("/health")
      ? { voice_available: true, tts_ready: true, gemini_configured: true }
      : { jobs: [job] },
  }));
  await page.goto("http://localhost:3000/movie");
  const summary = page.locator("summary").filter({ hasText: "笑い声" });
  await expect(summary).toHaveCount(1);
  await expect(page.getByText("文字にならない発声", { exact: true })).toHaveCount(0);
  await summary.click();
  await expect(page.getByLabel("読み・生成する台詞")).toHaveValue("");
});

test("Movie distinguishes pending and unresolved audio from confirmed nonverbal speech", async ({ page }) => {
  const job = {
    id: "unresolved-test", name: "未判定.mp4", state: "needs_review", size: 100,
    message: "発言を確認してください。", updated: 1, progress: 100, analyzed: true,
    confirmed: false, game_gain: 1, voice_gain: 1,
    segments: [
      {
        id: "1", start: 4.56, end: 5.284, text: "", reading: "",
        emotion: "neutral", style: "normal", mode: "tts", status: "pending",
        issue: "音声解析で内容を確認中の区間です。", analysis_issue: "pending_audio",
        nonverbal: false, revision: 0,
      },
      {
        id: "2", start: 918.182, end: 920.384, text: "", reading: "",
        emotion: "neutral", style: "normal", mode: "tts", status: "pending",
        issue: "音声解析を確認できませんでした。", analysis_issue: "audio_unavailable",
        analysis_failed: true, nonverbal: false, revision: 0,
      },
    ],
  };
  await page.addInitScript(() => localStorage.setItem("movie-current", "unresolved-test"));
  await page.route("**/api/movie/**", (route) => route.fulfill({
    json: route.request().url().endsWith("/health")
      ? { voice_available: true, tts_ready: true, gemini_configured: true }
      : { jobs: [job] },
  }));
  await page.goto("http://localhost:3000/movie");
  await expect(page.getByText("音声解析待ち", { exact: true })).toBeVisible();
  await expect(page.getByText("未判定の発声", { exact: true })).toBeVisible();
  await expect(page.getByText("文字にならない発声", { exact: true })).toHaveCount(0);
});
