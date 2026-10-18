import { expect, test, type Page } from "@playwright/test";
import { saveMovieAvatar } from "./movie-fixtures";

const MODEL_ID = `vasset_${"a".repeat(32)}`;
const REFERENCE_ID = `vasset_${"b".repeat(32)}`;

async function storedVoice(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open("chibichara-voice", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise<{ modelId: string | null; samples: number; previews: number }>((resolve, reject) => {
        const read = db.transaction("session").objectStore("session").get("current");
        read.onsuccess = () => resolve({
          modelId: read.result?.speakerJob?.result?.saved_asset_id ?? null,
          samples: read.result?.trainingSamples?.length ?? 0,
          previews: Object.keys(read.result?.trainedAudio ?? {}).length,
        });
        read.onerror = () => reject(read.error);
      });
    } finally { db.close(); }
  });
}

async function prepareSavedVoice(page: Page, { waitForDelete, failFirstDelete = false }: {
  waitForDelete?: Promise<void>;
  failFirstDelete?: boolean;
} = {}) {
  let modelExists = false;
  const deletedModels: string[] = [];
  await page.route("**/api/generate-speech", (route) => route.fulfill(
    route.request().method() === "GET"
      ? { json: { connected: true, speakerInversion: { ready: true, min_samples: 5 } } }
      : { contentType: "audio/wav", body: Buffer.from("voice-deletion-test") },
  ));
  await page.route("**/api/voice-reference", (route) => route.fulfill({
    json: route.request().method() === "DELETE" ? { deleted: true } : { voiceAssetId: REFERENCE_ID },
  }));
  await page.route("**/api/speaker-inversion", (route) => route.fulfill({ json: {
    id: "deletion-job", voice_id: "my-character", status: "completed", phase: "completed",
    sample_count: 5, message: "", error: null, progress: { current: 3000, total: 3000, ratio: 1 },
    result: { voice_id: "my-character", registered: true, saved: false, saved_asset_id: null, expires_at: null },
  } }));
  await page.route("**/api/speaker-inversion/deletion-job/save", (route) => {
    modelExists = true;
    return route.fulfill({ json: { id: MODEL_ID } });
  });
  await page.route("**/api/speaker-assets", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    deletedModels.push(route.request().postDataJSON().voiceAssetId);
    await waitForDelete;
    if (failFirstDelete && deletedModels.length === 1) {
      return route.fulfill({ status: 503, json: { error: "テスト用のモデル削除エラー" } });
    }
    modelExists = false;
    return route.fulfill({ json: { deleted: true, voiceAssetId: MODEL_ID } });
  });
  await page.route("**/api/movie/**", (route) => route.fulfill({ json:
    route.request().url().endsWith("/health")
      ? { voice_available: modelExists, tts_ready: true, gemini_configured: true }
      : { jobs: [] },
  }));
  await page.goto("/voice");
  await page.getByRole("button", { name: "声を生成（5本）", exact: true }).click();
  await page.getByRole("button", { name: "ボイスモデルを生成", exact: true }).click();
  await expect(page.getByRole("button", { name: "ボイスモデルを削除", exact: true })).toBeEnabled();
  await expect.poll(() => storedVoice(page)).toEqual({ modelId: MODEL_ID, samples: 5, previews: 5 });
  return { deletedModels, modelExists: () => modelExists };
}

test("deleting a voice removes the server model before clearing samples and disables Movie uploads", async ({ page }) => {
  let finishDeletion!: () => void;
  const waitForDelete = new Promise<void>((resolve) => { finishDeletion = resolve; });
  const state = await prepareSavedVoice(page, { waitForDelete });
  page.once("dialog", (dialog) => dialog.accept());
  const button = page.getByRole("button", { name: "ボイスモデルを削除", exact: true });
  try {
    await button.click();
    await expect(button).toBeDisabled();
    expect(await storedVoice(page)).toEqual({ modelId: MODEL_ID, samples: 5, previews: 5 });
    expect(state.modelExists()).toBe(true);
  } finally {
    finishDeletion();
  }
  await expect.poll(() => storedVoice(page)).toEqual({ modelId: null, samples: 0, previews: 0 });
  expect(state.deletedModels).toEqual([MODEL_ID]);
  expect(state.modelExists()).toBe(false);
  await saveMovieAvatar(page);
  await page.goto("/movie");
  await expect(page.getByRole("heading", { name: "ボイスモデルを作成してください", exact: true })).toBeVisible();
  await expect(page.getByLabel("MP4ファイル")).toBeDisabled();
});

test("failed model deletion keeps the saved voice and audio across reload and allows retry", async ({ page }) => {
  const state = await prepareSavedVoice(page, { failFirstDelete: true });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "ボイスモデルを削除", exact: true }).click();
  await expect(page.getByText("テスト用のモデル削除エラー", { exact: true })).toBeVisible();
  expect(await storedVoice(page)).toEqual({ modelId: MODEL_ID, samples: 5, previews: 5 });
  expect(state.modelExists()).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "ボイスモデルを削除", exact: true })).toBeEnabled();
  await expect(page.getByLabel("学習後の声 1を再生", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "ボイスモデルを削除", exact: true }).click();
  await expect.poll(() => storedVoice(page)).toEqual({ modelId: null, samples: 0, previews: 0 });
  expect(state.deletedModels).toEqual([MODEL_ID, MODEL_ID]);
  expect(state.modelExists()).toBe(false);
});
