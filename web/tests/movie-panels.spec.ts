import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`Movie panels toggle, switch and close without overlapping their buttons at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/api/movie/**", (route) => route.fulfill({ json:
      route.request().url().endsWith("/health")
        ? { backend: "runpod", voice_available: false, tts_ready: true, gemini_configured: true }
        : { jobs: [] },
    }));
    await page.goto("/movie");
    const historyButton = page.getByRole("button", { name: "最近の動画", exact: true });
    const settingsButton = page.getByRole("button", { name: "設定・詳細", exact: true });
    const history = page.getByRole("dialog", { name: "最近の動画", exact: true });
    const settings = page.getByRole("dialog", { name: "設定・詳細", exact: true });
    await expect(historyButton).toBeEnabled();
    const buttonPosition = await historyButton.boundingBox();

    await historyButton.click();
    await expect(history).toBeVisible();
    await expect(historyButton).toHaveAttribute("aria-expanded", "true");
    await expect(settingsButton).toHaveAttribute("aria-expanded", "false");
    await expect(history.getByRole("heading", { name: "最近の動画" })).toBeInViewport();
    const closePosition = await history.getByRole("button", { name: "閉じる" }).boundingBox();
    expect(closePosition!.y).toBeGreaterThan(buttonPosition!.y + buttonPosition!.height);
    expect(await historyButton.boundingBox()).toEqual(buttonPosition);
    await page.screenshot({ path: testInfo.outputPath("history-open.png") });
    await historyButton.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(historyButton).toBeFocused();

    await settingsButton.click();
    await expect(settings).toBeVisible();
    await expect(settingsButton).toHaveAttribute("aria-expanded", "true");
    await settingsButton.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(settingsButton).toBeFocused();

    await historyButton.click();
    await settingsButton.click();
    await expect(history).toHaveCount(0);
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("button", { name: "閉じる" })).toBeFocused();
    await historyButton.click();
    await expect(settings).toHaveCount(0);
    await expect(history).toBeVisible();
    await history.getByRole("button", { name: "閉じる" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(historyButton).toBeFocused();

    await settingsButton.click();
    await settingsButton.focus();
    await settingsButton.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(settingsButton).toBeFocused();
    await historyButton.click();
    await history.getByRole("button", { name: "閉じる" }).press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(historyButton).toBeFocused();
  });
}
