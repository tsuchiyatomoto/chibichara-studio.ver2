import { expect, test } from "@playwright/test";

test("Movie automatically continues a legacy vocalization preview job", async ({ page }) => {
  let job = {
    id: "laugh-test", name: "笑い声.mp4", state: "preview_ready", size: 100,
    message: "解析完了", updated: 1, progress: 100, analyzed: true,
    confirmed: false, game_gain: 1, voice_gain: 1,
    preview_ids: ["1"], segments: [{
      id: "1", start: 3.612, end: 4.58, text: "", reading: "",
      emotion: "joy", style: "laugh", mode: "tts", status: "done",
      issue: null, nonverbal: true, vocalization: "laugh", revision: 0,
    }],
  };
  let convertBody: unknown;
  await page.addInitScript(() => localStorage.setItem("movie-current", "laugh-test"));
  await page.route("**/api/movie/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/health")) return route.fulfill({ json: { voice_available: true, tts_ready: true, gemini_configured: true } });
    if (path.endsWith("/jobs")) return route.fulfill({ json: { jobs: [job] } });
    if (path.endsWith("/convert")) {
      convertBody = request.postDataJSON();
      job = { ...job, state: "queued", confirmed: true };
    }
    return route.fulfill({ json: job });
  });
  await page.goto("http://localhost:3000/movie");
  await expect.poll(() => convertBody).toEqual({ confirmed: true, game_gain: 1, voice_gain: 1 });
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByLabel("代表音声 1")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("Movie automatically continues muted legacy jobs without confirmation", async ({ page }) => {
  let job = {
    id: "unresolved-test", name: "未判定.mp4", state: "preview_ready", size: 100,
    message: "確認が必要な発言は無音にしました。", updated: 1, progress: 100, analyzed: true,
    confirmed: false, game_gain: 1, voice_gain: 1,
    segments: [
      {
        id: "1", start: 4.56, end: 5.284, text: "", reading: "",
        emotion: "neutral", style: "normal", mode: "mute", status: "accepted",
        issue: null, analysis_issue: "pending_audio",
        nonverbal: false, revision: 0,
      },
      {
        id: "2", start: 918.182, end: 920.384, text: "", reading: "",
        emotion: "neutral", style: "normal", mode: "mute", status: "accepted",
        issue: null, analysis_issue: "audio_unavailable",
        analysis_failed: true, nonverbal: false, revision: 0,
      },
    ],
  };
  let converted = false;
  await page.addInitScript(() => localStorage.setItem("movie-current", "unresolved-test"));
  await page.route("**/api/movie/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/health")) return route.fulfill({ json: { voice_available: true, tts_ready: true, gemini_configured: true } });
    if (path.endsWith("/jobs")) return route.fulfill({ json: { jobs: [job] } });
    if (path.endsWith("/convert")) {
      converted = true;
      job = { ...job, state: "queued", confirmed: true };
    }
    return route.fulfill({ json: job });
  });
  await page.goto("http://localhost:3000/movie");
  await expect.poll(() => converted).toBe(true);
  await expect(page.getByRole("button", { name: "全体を変換・続行" })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});
