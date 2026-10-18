import { expect, test, type Locator } from "@playwright/test";
import { saveMovieAvatar, saveMovieVoice } from "./movie-fixtures";

const health = { voice_available: true, tts_ready: true, gemini_configured: true };

async function appearance(locator: Locator) {
  return locator.evaluate((element) => {
    const css = getComputedStyle(element);
    return {
      background: css.backgroundColor,
      color: css.color,
      radius: css.borderRadius,
      weight: css.fontWeight,
      fontSize: css.fontSize,
    };
  });
}

test("Movie uses the same light panels and action buttons as Avatar and Voice", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/generate-speech", (route) => route.fulfill({ json: {
    connected: true, speakerInversion: { ready: true, min_samples: 5 },
  } }));
  await page.route("**/api/movie/**", (route) => route.fulfill({ json:
    route.request().url().endsWith("/health") ? health : { jobs: [] },
  }));

  await page.goto("/avatar");
  const avatarAction = page.getByRole("button", { name: "キャラクター生成", exact: true });
  await expect(avatarAction).toBeEnabled();
  await expect(avatarAction).toHaveCSS("background-color", "rgb(220, 38, 38)");
  await expect(avatarAction).toHaveCSS("color", "rgb(255, 255, 255)");
  const actionStyle = await appearance(avatarAction);
  const avatarCard = await appearance(page.locator("main form"));
  const avatarHeader = await page.getByRole("banner").boundingBox();
  const brandStyle = await appearance(page.getByRole("banner").getByText("chibichara studio"));
  const logoSource = await page.getByRole("banner").locator("img").getAttribute("src");
  await page.screenshot({ path: testInfo.outputPath("avatar-reference.png") });

  await page.goto("/voice");
  const voiceAction = page.getByRole("button", { name: "声を生成（5本）", exact: true });
  await expect(voiceAction).toBeEnabled();
  await expect.poll(() => appearance(voiceAction)).toEqual(actionStyle);
  const voiceCard = await appearance(page.locator("main form > div").first());
  expect(await page.getByRole("banner").boundingBox()).toEqual(avatarHeader);
  await page.screenshot({ path: testInfo.outputPath("voice-reference.png") });

  await saveMovieAvatar(page);
  await saveMovieVoice(page);
  await page.goto("/movie");
  const box = page.getByRole("region", { name: "Movie 動画ボックス" });
  const upload = box.getByRole("button", { name: "MP4を選択", exact: true });
  await expect(upload).toBeEnabled();
  await expect.poll(() => appearance(upload)).toEqual(actionStyle);
  const header = page.getByRole("banner");
  expect(await header.boundingBox()).toEqual(avatarHeader);
  expect(await appearance(header.getByText("chibichara studio"))).toEqual(brandStyle);
  await expect(header.locator("img")).toHaveAttribute("src", logoSource!);
  await expect(header.locator("img")).toHaveCSS("width", "72px");
  await expect(header.locator("img")).toHaveCSS("height", "72px");
  await expect.poll(() => header.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect((await box.boundingBox())!.y).toBeGreaterThan(avatarHeader!.y + avatarHeader!.height);
  const movieCard = await appearance(box);
  expect(movieCard.background).toBe(avatarCard.background);
  expect(movieCard.background).toBe(voiceCard.background);
  expect(movieCard.radius).toBe(avatarCard.radius);
  expect(movieCard.radius).toBe(voiceCard.radius);
  await expect(box).toHaveCSS("color-scheme", "light");
  await expect(box.locator("header")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(box.locator("footer")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.screenshot({ path: testInfo.outputPath("movie-desktop.png") });

  await upload.focus();
  await expect(upload).toHaveCSS("outline-style", "solid");
  await expect(upload).toHaveCSS("outline-color", "rgb(185, 28, 28)");
});

test("Movie settings and history keep the light studio design on narrow screens and in dark mode", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  const job = {
    id: "design-test", name: "配信アーカイブ.mp4", state: "ready", size: 100, received: 100,
    updated: 1, progress: 0, confirmed: false, game_gain: 1, voice_gain: 1, segments: [],
    game_index: 1, voice_index: 2,
    media: { codec: "h264", duration: 60, audio: [
      { index: 1, title: "ゲーム", channels: 2 }, { index: 2, title: "実況", channels: 1 },
    ] },
  };
  await page.addInitScript((id) => localStorage.setItem("movie-current", id), job.id);
  await page.route("**/api/movie/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("/files/")) return route.abort();
    return route.fulfill({ json: path.endsWith("/health") ? health : { jobs: [job] } });
  });
  await page.goto("/movie");
  const box = page.getByRole("region", { name: "Movie 動画ボックス" });
  await expect(box.getByRole("heading", { name: "アップロードした動画を確認" })).toHaveCount(0);
  await expect(box.getByRole("button", { name: "変換を開始" })).toBeVisible();
  await expect(box.getByRole("combobox")).toHaveCount(0);
  await expect(box).toHaveCSS("color-scheme", "light");
  await expect(page.getByRole("banner").locator("img")).toBeInViewport();
  await expect(page.getByRole("banner")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  const mobileBox = (await box.boundingBox())!;
  const mobileNavigation = (await page.getByRole("navigation", { name: "スタジオメニュー" }).boundingBox())!;
  expect(mobileBox.y + mobileBox.height).toBeLessThan(mobileNavigation.y);
  await page.screenshot({ path: testInfo.outputPath("movie-ready-mobile.png") });

  await box.getByRole("button", { name: "設定・詳細" }).click();
  const settings = box.getByRole("dialog", { name: "設定・詳細" });
  await expect(settings).toHaveCSS("background-color", "rgb(255, 253, 245)");
  await expect(settings.getByRole("heading", { name: "設定・詳細" })).toHaveCSS("color", "rgb(23, 23, 23)");
  await expect(settings.getByLabel("ゲーム用語・固有名詞（任意）")).toHaveCSS("background-color", "rgb(255, 254, 250)");
  await page.screenshot({ path: testInfo.outputPath("movie-settings-mobile.png") });
  await settings.getByRole("button", { name: "閉じる" }).press("Escape");
  await expect(box.getByRole("button", { name: "設定・詳細" })).toBeFocused();

  await box.getByRole("button", { name: "最近の動画" }).click();
  const history = box.getByRole("dialog", { name: "最近の動画" });
  await expect(history).toHaveCSS("background-color", "rgb(255, 253, 245)");
  await expect(history.locator('[aria-current="true"]')).toHaveCSS("background-color", "rgb(230, 250, 255)");
  await page.screenshot({ path: testInfo.outputPath("movie-history-mobile.png") });
  const playerBounds = (await box.boundingBox())!;
  const panelBounds = (await history.boundingBox())!;
  expect(panelBounds.x).toBeGreaterThanOrEqual(playerBounds.x);
  expect(panelBounds.y).toBeGreaterThanOrEqual(playerBounds.y);
  expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(playerBounds.x + playerBounds.width);
  expect(panelBounds.y + panelBounds.height).toBeLessThanOrEqual(playerBounds.y + playerBounds.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await history.getByRole("button", { name: "閉じる" }).click();
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(box.getByRole("button", { name: "設定・詳細" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
