import { expect, test, type Page } from "@playwright/test";
import type { Job } from "../app/movie/movie-types";
import { saveMovieAvatar, saveMovieVoice } from "./movie-fixtures";

const health = { voice_available: true, tts_ready: true, gemini_configured: true, max_bytes: 1024 ** 3, chunk_bytes: 8 * 1024 ** 2 };

async function mockMovie(page: Page, voiceAvailable: boolean, jobs: Job[] = []) {
  const mutations: string[] = [];
  await page.route("**/api/movie/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/movie/", "");
    if (path === "health") return route.fulfill({ json: { ...health, voice_available: voiceAvailable } });
    if (path === "jobs") return route.fulfill({ json: { jobs } });
    if (path.includes("/files/")) return route.abort();
    if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 400, json: { error: "Unexpected Movie request" } });
  });
  return mutations;
}

async function dropMovie(page: Page) {
  const box = page.getByRole("region", { name: "Movie 動画ボックス" });
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["test movie"], "test.mp4", { type: "video/mp4" }));
    return data;
  });
  try {
    await box.dispatchEvent("dragenter", { dataTransfer: transfer });
    await expect(box.getByText("ここにドロップしてアップロード", { exact: true })).toHaveCount(0);
    await box.dispatchEvent("drop", { dataTransfer: transfer });
  } finally {
    await transfer.dispose();
  }
}

for (const { voice, avatar, heading } of [
  { voice: false, avatar: true, heading: "ボイスモデルを作成してください" },
  { voice: true, avatar: false, heading: "アバターを作成してください" },
  { voice: false, avatar: false, heading: "ボイスモデルとアバターを作成してください" },
]) {
  test(`Movie requires saved assets: voice=${voice}, avatar=${avatar}`, async ({ page }, testInfo) => {
    const mutations = await mockMovie(page, voice);
    if (voice) await saveMovieVoice(page);
    if (avatar) await saveMovieAvatar(page);
    if (!voice && !avatar) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/movie");
    const box = page.getByRole("region", { name: "Movie 動画ボックス" });
    await expect(box.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(box.getByRole("heading", { name: "動画をここにドロップ", exact: true })).toHaveCount(0);
    await expect(box.getByRole("button", { name: "MP4を選択", exact: true })).toHaveCount(0);
    await expect(box.getByLabel("MP4ファイル")).toBeDisabled();
    const voiceLink = box.getByRole("link", { name: "ボイスモデルを作成", exact: true });
    const avatarLink = box.getByRole("link", { name: "アバターを作成", exact: true });
    if (voice) await expect(voiceLink).toHaveCount(0);
    else await expect(voiceLink).toHaveAttribute("href", "/voice");
    if (avatar) await expect(avatarLink).toHaveCount(0);
    else await expect(avatarLink).toHaveAttribute("href", "/avatar");

    await dropMovie(page);
    // Programmatic file selection must also be rejected by the upload handler.
    await box.getByLabel("MP4ファイル").setInputFiles({ name: "test.mp4", mimeType: "video/mp4", buffer: Buffer.from("test") });
    expect(mutations).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("movie-upload"))).toBeNull();
    if (!voice && !avatar) {
      await expect(voiceLink).toBeInViewport();
      await expect(avatarLink).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("missing-assets-mobile.png") });
    }
  });
}

test("Movie waits for saved assets before showing the upload screen", async ({ page }) => {
  await saveMovieAvatar(page);
  await saveMovieVoice(page);
  let finishLoading!: () => void;
  const pending = new Promise<void>((resolve) => { finishLoading = resolve; });
  const mutations: string[] = [];
  await page.route("**/api/movie/**", async (route) => {
    if (route.request().url().endsWith("/health")) {
      await pending;
      return route.fulfill({ json: health });
    }
    if (route.request().method() !== "GET") mutations.push(route.request().url());
    return route.fulfill({ json: { jobs: [] } });
  });
  try {
    await page.goto("/movie");
    await expect(page.getByRole("heading", { name: "Movieの準備を確認しています…", exact: true })).toBeVisible();
    await expect(page.getByLabel("MP4ファイル")).toBeDisabled();
    await dropMovie(page);
    expect(mutations).toEqual([]);
  } finally {
    finishLoading();
  }
  await expect(page.getByRole("heading", { name: "動画をここにドロップ", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "MP4を選択", exact: true })).toBeEnabled();
});

for (const { name, frames } of [
  { name: "a character without poses", frames: null },
  { name: "an incomplete pose", frames: Array(3).fill("data:image/png;base64,dGVzdA==") },
  { name: "non-PNG frames", frames: Array(4).fill("data:image/svg+xml;base64,dGVzdA==") },
]) {
  test(`Movie rejects ${name} as a saved avatar`, async ({ page }) => {
    await mockMovie(page, true);
    await saveMovieVoice(page);
    await saveMovieAvatar(page, frames);
    await page.goto("/movie");
    await expect(page.getByRole("heading", { name: "アバターを作成してください", exact: true })).toBeVisible();
    await expect(page.getByLabel("MP4ファイル")).toBeDisabled();
  });
}

for (const state of ["ready", "uploading", "expired"] as const) {
  test(`Movie blocks replacement uploads for an existing ${state} job when the avatar is missing`, async ({ page }) => {
    const job: Job = {
      id: "missing-avatar", name: "existing.mp4", state, size: 100, received: 50,
      message: "", updated: 1, progress: 0, confirmed: false, game_gain: 1, voice_gain: 1, segments: [],
      media: { codec: "h264", duration: 1, audio: [] },
    };
    const mutations = await mockMovie(page, true, [job]);
    await saveMovieVoice(page);
    await page.addInitScript((id) => localStorage.setItem("movie-current", id), job.id);
    await page.goto("/movie");
    const box = page.getByRole("region", { name: "Movie 動画ボックス" });
    await expect(box.getByRole("button", { name: "別のMP4を選択", exact: true })).toBeDisabled();
    await expect(box.getByLabel("MP4ファイル")).toBeDisabled();
    if (state === "uploading") await expect(box.getByRole("button", { name: "同じMP4を選択して再開", exact: true })).toBeDisabled();
    if (state === "ready") await expect(box.getByRole("button", { name: "変換を開始", exact: true })).toBeDisabled();
    if (state === "expired") await expect(box.getByRole("heading", { name: "アバターを作成してください", exact: true })).toBeVisible();
    await dropMovie(page);
    expect(mutations).toEqual([]);
  });
}

test("a model left on the server after local deletion does not enable movie uploads", async ({ page }) => {
  const mutations = await mockMovie(page, true);
  await saveMovieAvatar(page);
  await page.goto("/movie");
  await expect(page.getByRole("heading", { name: "ボイスモデルを作成してください", exact: true })).toBeVisible();
  await expect(page.getByLabel("MP4ファイル")).toBeDisabled();
  await dropMovie(page);
  expect(mutations).toEqual([]);
});
