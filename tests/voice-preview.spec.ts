import { test, expect } from "@playwright/test";

for (const failSecond of [false, true]) {
  test(`saved voice automatically generates five previews${failSecond ? " and allows retry after failure" : ""}`, async ({ page }) => {
    const requests: { input: string; voiceAssetId: string }[] = [];
    let saved = false;
    await page.addInitScript(() => {
      localStorage.setItem("chibichara-speaker-inversion-job", "test-job");
    });
    await page.route("**/api/speaker-inversion/test-job", (route) => route.fulfill({
      json: {
        id: "test-job", voice_id: "test-voice", status: "completed",
        phase: "completed", sample_count: 5, message: "", error: null,
        progress: { current: 3000, total: 3000, ratio: 1 },
        result: { voice_id: "test-voice", registered: true, saved: false, saved_asset_id: null, expires_at: null },
      },
    }));
    await page.route("**/api/speaker-inversion/test-job/save", (route) => {
      saved = true;
      return route.fulfill({ json: { id: "saved-voice" } });
    });
    await page.route("**/api/generate-speech", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: { connected: true, model: "irodori-tts" } });
      }
      expect(saved).toBe(true);
      requests.push(route.request().postDataJSON());
      if (failSecond && requests.length === 2) {
        return route.fulfill({ status: 500, json: { error: "Test failure" } });
      }
      await route.fulfill({ contentType: "audio/wav", body: Buffer.from("test-audio") });
    });
    await page.goto("http://localhost:3000/voice");
    await expect.poll(() => requests.length).toBe(5);
    await expect(page.getByRole("button", { name: "学習後の声", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(new Set(requests.map((request) => request.input)).size).toBe(5);
    expect(requests.every((request) => request.voiceAssetId === "saved-voice")).toBe(true);
    await expect(page.getByLabel("学習後の声 1を再生")).toBeVisible();
    if (failSecond) {
      await expect(page.getByText(/文章2の音声を生成できませんでした/)).toBeVisible();
      await page.getByRole("button", { name: "次の文章へ" }).click();
      await page.getByRole("button", { name: "この文章で声を確認", exact: true }).click();
      await expect(page.getByLabel("学習後の声 2を再生")).toBeVisible();
      expect(requests).toHaveLength(6);
      expect(requests[5]).toEqual(requests[1]);
    } else {
      for (let index = 2; index <= 5; index++) {
        await page.getByRole("button", { name: "次の文章へ" }).click();
        await expect(page.getByLabel(`学習後の声 ${index}を再生`)).toBeVisible();
      }
      expect(requests).toHaveLength(5);
    }
  });
}
