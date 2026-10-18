import type { Page } from "@playwright/test";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC0kAAAAASUVORK5CYII=";

export async function saveMovieVoice(page: Page, voiceAssetId = `vasset_${"a".repeat(32)}`) {
  await page.goto("/");
  await page.evaluate(async (voiceAssetId) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("chibichara-voice", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("session");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction("session", "readwrite");
        // Movie reads only the identity of the locally saved model.
        transaction.objectStore("session").put({
          version: 1,
          speakerJob: { result: { saved: true, saved_asset_id: voiceAssetId } },
        }, "current");
        transaction.oncomplete = () => { open.result.close(); resolve(); };
        transaction.onerror = () => { open.result.close(); reject(transaction.error); };
      };
    });
  }, voiceAssetId);
}

export async function saveMovieAvatar(page: Page, frames: string[] | null = Array(4).fill(PNG)) {
  await page.goto("/");
  await page.evaluate(async ({ frames, image }) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("chibichara-avatar", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("session");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction("session", "readwrite");
        transaction.objectStore("session").put({
          version: 1,
          character: { image },
          avatarPoses: frames ? [{ id: "basic", label: "ポーズ1", frames }] : [],
        }, "images");
        transaction.oncomplete = () => { open.result.close(); resolve(); };
        transaction.onerror = () => { open.result.close(); reject(transaction.error); };
      };
    });
  }, { frames, image: PNG });
}
