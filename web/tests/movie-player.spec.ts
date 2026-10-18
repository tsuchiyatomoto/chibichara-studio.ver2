import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Job } from "../app/movie/movie-types";
import { saveMovieAvatar, saveMovieVoice } from "./movie-fixtures";

const health = { voice_available: true, tts_ready: true, gemini_configured: true, max_bytes: 1024 ** 3, chunk_bytes: 8 * 1024 ** 2 };
const baseJob: Job = {
  id: "player-test", name: "playthrough.mp4", state: "uploading", size: 100,
  received: 0, message: "動画を処理しています。", updated: 1, progress: 0,
  confirmed: false, game_gain: 1, voice_gain: 1, segments: [],
};

test("one video box previews the upload before fixed-track conversion and download", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  // A playable local movie verifies that the finished video is usable, not just a URL.
  const fixture = testInfo.outputPath("input.mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x18344b:s=320x180:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture]);
  const bytes = readFileSync(fixture);
  let job: Job | null = null;
  let analyzeBody: unknown;
  let convertBody: unknown;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/movie/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/movie/", "");
    if (path === "health") return route.fulfill({ json: health });
    if (path === "jobs") return route.fulfill({ json: { jobs: job ? [job] : [] } });
    if (path === "uploads") {
      job = { ...baseJob, ...request.postDataJSON() };
    } else if (path.startsWith("uploads/") && request.method() === "PUT") {
      job!.received += request.postDataBuffer()!.length;
      return route.fulfill({ json: { received: job!.received } });
    } else if (path.endsWith("/complete")) {
      job = { ...job!, state: "queued", game_index: 1, voice_index: 2, media: { codec: "h264", duration: 1, audio: [
        { index: 1, title: "Game", channels: 2 }, { index: 2, title: "Mic", channels: 1 },
      ] } };
    } else if (path.endsWith("/analyze")) {
      analyzeBody = request.postDataJSON();
      job = { ...job!, state: "analyzing" };
    } else if (path.includes("/avatar-assets/")) {
      return route.fulfill({ json: { name: path.split("/").at(-1) } });
    } else if (path.endsWith("/avatar")) {
      job = { ...job!, avatar: request.postDataJSON() };
    } else if (path.endsWith("/convert")) {
      convertBody = request.postDataJSON();
      job = { ...job!, ...request.postDataJSON(), state: "synthesizing", progress: 25 };
    } else if (path.includes("/files/")) {
      return route.fulfill({ contentType: "video/mp4", body: bytes });
    } else if (path === `jobs/${baseJob.id}`) {
      if (job!.state === "queued") job = { ...job!, state: "ready" };
      else if (job!.state === "analyzing") job = { ...job!, state: "synthesizing", analyzed: true, segments: [{
        id: "1", start: 0, end: 1, text: "テスト", reading: "テスト", emotion: "neutral", style: "normal", mode: "tts", status: "done", issue: null, revision: 0,
      }] };
      else if (job!.state === "synthesizing") job = { ...job!, state: "completed", updated: 2, progress: 100 };
    }
    return route.fulfill({ json: job });
  });
  await saveMovieAvatar(page);
  await saveMovieVoice(page);
  await page.goto("/movie");
  const box = page.getByRole("region", { name: "Movie 動画ボックス" });
  await expect(box.getByRole("button", { name: "MP4を選択", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("empty-desktop.png") });
  const transfer = await page.evaluateHandle((data) => {
    const payload = new DataTransfer();
    payload.items.add(new File([new Uint8Array(data)], "playthrough.mp4", { type: "video/mp4" }));
    return payload;
  }, [...bytes]);
  await box.dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(box.getByText("ここにドロップしてアップロード")).toBeVisible();
  await box.dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  await expect(box.getByRole("heading", { name: "アップロードした動画を確認" })).toHaveCount(0);
  await expect(box.getByRole("button", { name: "変換を開始" })).toBeVisible();
  await expect(box.getByText("Voiceで保存した声を使用", { exact: true })).toHaveCount(0);
  await expect(box.getByRole("combobox")).toHaveCount(0);
  await expect(box.locator("audio")).toHaveCount(0);
  const uploadedVideo = box.getByLabel("アップロードした動画");
  await expect(uploadedVideo).toHaveAttribute("src", /^blob:/);
  await expect(uploadedVideo).toHaveJSProperty("controls", true);
  await expect(uploadedVideo).toHaveJSProperty("muted", false);
  await expect(uploadedVideo).toHaveJSProperty("readyState", 4);
  await uploadedVideo.evaluate((element: HTMLVideoElement) => element.play());
  await expect(uploadedVideo).toHaveJSProperty("paused", false);
  await uploadedVideo.evaluate((element: HTMLVideoElement) => element.pause());
  await box.getByRole("button", { name: "設定・詳細" }).click();
  await page.getByLabel("ゲーム用語・固有名詞（任意）").fill("テスト用語");
  await page.getByRole("button", { name: "閉じる" }).press("Escape");
  await expect(box.getByRole("button", { name: "設定・詳細" })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("ready-desktop.png") });
  await box.getByRole("button", { name: "変換を開始" }).click();
  await expect(box.getByRole("link", { name: "MP4をダウンロード" })).toHaveAttribute("href", `/api/movie/jobs/${baseJob.id}/files/output.mp4`, { timeout: 15_000 });
  expect(analyzeBody).toEqual({ game_index: 1, voice_index: 2, glossary: "テスト用語" });
  await expect(box.getByText("キャラクターの声を試聴")).toHaveCount(0);
  await expect(box.getByRole("button", { name: "全体を変換・続行" })).toHaveCount(0);
  await expect(box.getByRole("checkbox")).toHaveCount(0);
  expect(convertBody).toBeUndefined();
  const video = box.getByLabel("完成動画");
  await expect(video).toHaveJSProperty("readyState", 4);
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect(video).toHaveJSProperty("paused", false);
  await box.getByRole("button", { name: "設定・詳細" }).click();
  await page.getByLabel("ゲーム音量", { exact: false }).fill("0.5");
  await page.getByRole("button", { name: "音量を反映して書き出す" }).click();
  await expect(box.getByRole("progressbar")).toBeVisible();
  await expect(box.getByLabel("完成動画")).toBeVisible({ timeout: 15_000 });
  await expect(box.getByRole("progressbar")).toHaveCount(0);
  await expect(video).toHaveJSProperty("readyState", 4);
  expect(convertBody).toEqual({ confirmed: true, game_gain: 0.5, voice_gain: 1 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("completed-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test("saved Avatar can be placed freely and is snapshotted before analysis", async ({ page }, testInfo) => {
  const moviePath = testInfo.outputPath("avatar-input.mp4");
  const imagePath = testInfo.outputPath("avatar.png");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x18344b:s=320x180:r=10:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", moviePath]);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red@0.8:s=64x64", "-frames:v", "1", "-vf", "format=rgba", imagePath]);
  const movie = readFileSync(moviePath);
  const image = readFileSync(imagePath);
  const dataUrl = `data:image/png;base64,${image.toString("base64")}`;
  const id = "avatar-player";
  let job: Job = {
    ...baseJob,
    id,
    state: "ready",
    size: movie.length,
    received: movie.length,
    media: { codec: "h264", duration: 2, audio: [
      { index: 1, title: "Game", channels: 2 }, { index: 2, title: "Mic", channels: 1 },
    ] },
  };
  const requests: string[] = [];
  await page.route("**/api/movie/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/movie/", "");
    if (path === "health") return route.fulfill({ json: health });
    if (path === "jobs") return route.fulfill({ json: { jobs: [job] } });
    if (path === `jobs/${id}`) return route.fulfill({ json: job });
    if (path === `jobs/${id}/files/input.mp4`) return route.fulfill({ contentType: "video/mp4", body: movie });
    if (path.startsWith(`jobs/${id}/avatar-assets/`)) {
      requests.push(`${request.method()} ${path}`);
      expect(request.postDataBuffer()?.subarray(0, 8)).toEqual(image.subarray(0, 8));
      return route.fulfill({ json: { name: path.split("/").at(-1) } });
    }
    if (path === `jobs/${id}/avatar`) {
      requests.push(`POST ${path}`);
      const body = request.postDataJSON();
      expect(body.poses[0]).toEqual({
        id: "basic",
        label: "基本",
        frames: ["avatar-0-0.png", "avatar-0-1.png", "avatar-0-2.png", "avatar-0-3.png"],
      });
      job = { ...job, avatar: { ...body, seed: 99 } };
      return route.fulfill({ json: job });
    }
    if (path === `jobs/${id}/analyze`) {
      requests.push(`POST ${path}`);
      job = { ...job, state: "analyzing" };
      return route.fulfill({ json: job });
    }
    return route.fulfill({ status: 404, json: { error: path } });
  });
  await saveMovieVoice(page);
  await page.evaluate(async ({ id, dataUrl }) => {
    localStorage.setItem("movie-current", id);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("chibichara-avatar", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("session");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction("session", "readwrite");
        transaction.objectStore("session").put({
          version: 1,
          character: null,
          avatarPoses: [{ id: "basic", label: "基本", provider: "openai", frames: [dataUrl, dataUrl, dataUrl, dataUrl] }],
        }, "images");
        transaction.oncomplete = () => { open.result.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, { id, dataUrl });
  await page.goto("/movie");
  const box = page.getByRole("region", { name: "Movie 動画ボックス" });
  const avatar = box.getByAltText("動画に重ねるアバター");
  await expect(avatar).toBeVisible();
  await box.getByRole("button", { name: "アバターの配置を調整" }).click();
  await expect(box.getByText("アバターをドラッグして移動できます。", { exact: false })).toBeVisible();
  const sliders = box.getByRole("slider");
  await sliders.nth(0).fill("0.7");
  await sliders.nth(1).fill("25");
  await box.getByRole("button", { name: "左右を反転" }).click();
  const before = await avatar.boundingBox();
  expect(before).not.toBeNull();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x - 45, before!.y - 25);
  await page.mouse.up();
  const placement = await page.evaluate((id) => JSON.parse(localStorage.getItem(`movie-avatar-placement:${id}`)!), id);
  expect(placement.scale).toBe(0.7);
  expect(placement.rotation).toBe(25);
  expect(placement.flip_x).toBe(true);
  expect(placement.x).toBeLessThan(0.82);
  await box.getByRole("button", { name: "変換を開始" }).click();
  await expect(box.getByRole("progressbar")).toBeVisible();
  expect(requests.slice(0, 4)).toEqual([
    `PUT jobs/${id}/avatar-assets/avatar-0-0.png`,
    `PUT jobs/${id}/avatar-assets/avatar-0-1.png`,
    `PUT jobs/${id}/avatar-assets/avatar-0-2.png`,
    `PUT jobs/${id}/avatar-assets/avatar-0-3.png`,
  ]);
  expect(requests.at(-2)).toBe(`POST jobs/${id}/avatar`);
  expect(requests.at(-1)).toBe(`POST jobs/${id}/analyze`);
});

test("settings wait for the saved movie to finish loading", async ({ page }) => {
  const job = { ...baseJob, state: "failed" };
  let finishLoading!: () => void;
  const restored = new Promise<void>((resolve) => { finishLoading = resolve; });
  await page.addInitScript((id) => localStorage.setItem("movie-current", id), job.id);
  await page.route("**/api/movie/**", async (route) => {
    if (route.request().url().endsWith("/health")) return route.fulfill({ json: health });
    await restored;
    return route.fulfill({ json: { jobs: [job] } });
  });
  try {
    await page.goto("/movie");
    await expect(page.getByRole("button", { name: "設定・詳細" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "最近の動画" })).toBeDisabled();
  } finally {
    finishLoading();
  }
  await page.getByRole("button", { name: "設定・詳細" }).click();
  const panel = page.getByRole("dialog", { name: "設定・詳細" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(job.name, { exact: true })).toBeVisible();
});

test("history and failure recovery stay inside the video box on mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let job: Job = { ...baseJob, state: "failed", error: "音声サーバーに接続できません。" };
  let deleted = false;
  let resumed = false;
  await page.addInitScript((id) => localStorage.setItem("movie-current", id), job.id);
  await page.route("**/api/movie/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/health")) return route.fulfill({ json: health });
    if (path.endsWith("/jobs")) return route.fulfill({ json: { jobs: deleted ? [] : [job] } });
    if (path.endsWith("/resume")) { resumed = true; job = { ...job, state: "analyzing", error: undefined }; }
    if (path.endsWith("/cancel")) job = { ...job, state: "cancelled" };
    if (route.request().method() === "DELETE") { deleted = true; return route.fulfill({ json: { deleted: true } }); }
    return route.fulfill({ json: job });
  });
  await page.goto("/movie");
  const box = page.getByRole("region", { name: "Movie 動画ボックス" });
  await expect(box.getByRole("alert")).toHaveText(job.error!);
  await box.getByRole("button", { name: "未完了の工程から再開" }).click();
  await expect(box.getByRole("progressbar")).toBeVisible();
  expect(resumed).toBe(true);
  await box.getByRole("button", { name: "処理を中止", exact: true }).click();
  await box.getByRole("button", { name: "最近の動画" }).click();
  await expect(box.getByRole("dialog", { name: "最近の動画" })).toBeVisible();
  await box.getByRole("button", { name: /playthrough.mp4 中止済み/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await box.getByRole("button", { name: "最近の動画" }).click();
  await box.getByRole("button", { name: "playthrough.mp4を削除" }).click();
  await expect(box.getByRole("heading", { name: "アバターを作成してください" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("movie-current"))).toBeNull();
  await page.screenshot({ path: testInfo.outputPath("empty-mobile.png") });
});
