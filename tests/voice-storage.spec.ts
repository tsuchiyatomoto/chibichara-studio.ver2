import { expect, test, type Page } from "@playwright/test";

async function storedCounts(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("chibichara-voice", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<number[]>((resolve, reject) => {
        const request = db.transaction("session").objectStore("session").get("current");
        request.onsuccess = () => resolve([
          request.result?.trainingSamples.length ?? 0,
          Object.keys(request.result?.trainedAudio ?? {}).length,
        ]);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
}

async function audioBytes(page: Page, label: string) {
  return page.getByLabel(label, { exact: true }).evaluate(async (audio: HTMLAudioElement) =>
    (await fetch(audio.src)).text());
}

for (const partial of [false, true]) {
  test(`voice audio persists across reload${partial ? " and an interrupted batch resumes" : " before and after training, until deleted"}`, async ({ page }) => {
    let requests = 0;
    let references = 0;
    let jobRequests = 0;
    let trainingBody = "";
    const speech: { input: string; voiceAssetId?: string }[] = [];
    const completedJob = {
      id: "stored-job", voice_id: "my-character", status: "completed", phase: "completed",
      sample_count: 5, message: "", error: null,
      progress: { current: 3000, total: 3000, ratio: 1 },
      result: { voice_id: "my-character", registered: true, saved: false, saved_asset_id: null, expires_at: null },
    };
    await page.route("**/api/generate-speech", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: {
        connected: true, speakerInversion: { ready: true, min_samples: 5 },
      } });
      requests++;
      speech.push(route.request().postDataJSON());
      if (partial && requests === 2) return route.fulfill({ status: 503, json: { error: "interrupted" } });
      return route.fulfill({ contentType: "audio/wav", body: Buffer.from(`voice-bytes-${requests}`) });
    });
    await page.route("**/api/voice-reference", (route) => {
      if (route.request().method() === "DELETE") return route.fulfill({ json: { deleted: true } });
      references++;
      return route.fulfill({ json: { voiceAssetId: `reference-${references}` } });
    });
    await page.route("**/api/speaker-inversion", (route) => {
      trainingBody = route.request().postDataBuffer()!.toString();
      return route.fulfill({ json: completedJob });
    });
    await page.route("**/api/speaker-inversion/stored-job", (route) => {
      jobRequests++;
      return route.fulfill({ status: 404, json: { error: "Expired job" } });
    });
    await page.route("**/api/speaker-inversion/stored-job/save", (route) =>
      route.fulfill({ json: { id: "saved-voice" } }));
    await page.goto("http://localhost:3000/voice");
    await page.getByRole("button", { name: "声を生成（5本）", exact: true }).click();
    await expect.poll(() => storedCounts(page)).toEqual([partial ? 1 : 5, 0]);
    await page.reload();
    await expect(page.getByRole("button", { name: "ボイスをすべて削除", exact: true })).toBeEnabled();
    expect(requests).toBe(partial ? 2 : 5);
    if (partial) {
      await page.getByRole("button", { name: "前の文章へ" }).click();
      expect(await audioBytes(page, "学習前の声 1を再生")).toBe("voice-bytes-1");
      await page.getByRole("button", { name: "残り4本を生成", exact: true }).click();
      await expect.poll(() => storedCounts(page)).toEqual([5, 0]);
      expect(requests).toBe(6);
      expect(references).toBe(2);
      expect(speech.slice(2).every((r) => r.voiceAssetId === "reference-2")).toBe(true);
      return;
    }
    expect(await audioBytes(page, "学習前の声 5を再生")).toBe("voice-bytes-5");
    await page.getByRole("button", { name: "ボイスモデルを生成", exact: true }).click();
    await expect.poll(() => storedCounts(page)).toEqual([5, 5]);
    expect(trainingBody).toContain("voice-bytes-1");
    expect(trainingBody).toContain("voice-bytes-5");
    await page.reload();
    await expect(page.getByLabel("学習後の声 1を再生", { exact: true })).toBeVisible();
    expect(await audioBytes(page, "学習後の声 1を再生")).toBe("voice-bytes-6");
    expect(requests).toBe(10); // No re-generation on reload.
    expect(jobRequests).toBe(0); // Saved audio survives job expiration, too.
    await page.getByRole("button", { name: "学習前の声", exact: true }).click();
    expect(await audioBytes(page, "学習前の声 1を再生")).toBe("voice-bytes-1");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "ボイスモデルを削除", exact: true }).click();
    await expect.poll(() => storedCounts(page)).toEqual([0, 0]);
    await page.reload();
    await expect(page.getByRole("button", { name: "声を生成（5本）", exact: true })).toBeEnabled();
    await expect(page.locator("audio")).toHaveCount(0);
    expect(requests).toBe(10);
  });
}
