import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { saveMovieAvatar, saveMovieVoice } from "./movie-fixtures";

test("Movie uploads two tracks, resumes after reload, and scopes private media", async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const status = await page.request.get("http://localhost:3000/api/movie/health");
  test.skip(!status.ok() || !(await status.json()).voice_available,
    "Requires a running Movie/TTS service with a saved voice model.");
  await saveMovieAvatar(page);
  const voices = await (await page.request.get("http://localhost:3000/api/speaker-assets")).json();
  await saveMovieVoice(page, voices.data[0].id);
  const directory = path.resolve("../.movie-data/ui-check");
  mkdirSync(directory, { recursive: true });
  const input = path.join(directory, "two-tracks.mp4");
  execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x90:r=10:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=3",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-map",
    "2:a",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-t",
    "3",
    input,
  ]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:3000/movie");
  await expect(
    page.getByRole("heading", { name: "動画をここにドロップ" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "実況音声をGoogleへ送信し、感情・話し方を解析することを確認しました。",
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "MP4を選択", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("MP4ファイル").setInputFiles(input);
  await expect.poll(
    () => page.evaluate(() => localStorage.getItem("movie-current")),
  ).not.toBeNull();
  const id = await page.evaluate(() => localStorage.getItem("movie-current"));
  await expect.poll(async () => {
    const response = await page.request.get(`http://localhost:3000/api/movie/jobs/${id}`);
    return (await response.json()).state;
  }).not.toBe("uploading");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.locator("audio")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "two-tracks.mp4", exact: true }),
  ).toBeVisible();
  const range = await page.request.get(`http://localhost:3000/api/movie/jobs/${id}/files/input.mp4`, {
    headers: { Range: "bytes=0-15" },
  });
  expect(range.status()).toBe(206);
  const other = await browser.newContext();
  expect(
    (
      await other.request.get(`http://localhost:3000/api/movie/jobs/${id}`)
    ).status(),
  ).toBe(404);
  await other.close();
  await page.screenshot({
    path: path.join(directory, "movie-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(directory, "movie-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
  await page.request.post(`http://localhost:3000/api/movie/jobs/${id}/cancel`);
  await expect.poll(async () => {
    const response = await page.request.get(`http://localhost:3000/api/movie/jobs/${id}`);
    return (await response.json()).state;
  }).toMatch(/^(ready|failed|cancelled)$/);
  expect((await page.request.delete(`http://localhost:3000/api/movie/jobs/${id}`)).ok()).toBe(true);
});
