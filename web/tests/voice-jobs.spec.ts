import { expect, test } from "@playwright/test";

test("an accepted speech job survives reload and restores audio without a second generation", async ({ page }) => {
  let creates = 0;
  let polls = 0;
  let completed = false;
  const ident = "job_" + "e".repeat(32);
  await page.route("**/api/generate-speech", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { connected: true } });
    creates++;
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    return route.fulfill({ status: 202, json: { id: ident, status: "queued" } });
  });
  await page.route(`**/api/speech-jobs/${ident}`, (route) => {
    polls++;
    return route.fulfill({ json: { id: ident, status: completed ? "completed" : "running" } });
  });
  await page.route(`**/api/speech-jobs/${ident}/content`, (route) =>
    route.fulfill({ contentType: "audio/wav", body: Buffer.from("durable-audio") }));
  await page.route("**/api/voice-reference", (route) => route.fulfill({ json: { voiceAssetId: "restored-reference" } }));
  await page.goto("/voice");
  await page.getByRole("button", { name: "声を生成（5本）", exact: true }).click();
  await expect.poll(() => polls).toBeGreaterThan(0);
  expect(creates).toBe(1);
  await page.reload();
  await expect.poll(() => polls).toBeGreaterThan(1);
  completed = true;
  const audio = page.getByLabel("学習前の声 1を再生", { exact: true });
  await expect(audio).toBeVisible();
  expect(await audio.evaluate(async (element: HTMLAudioElement) => (await fetch(element.src)).text())).toBe("durable-audio");
  expect(creates).toBe(1);
  await expect(page.getByRole("button", { name: "残り4本を生成", exact: true })).toBeEnabled();
});

test("a failed reference registration retries the finished WAV without synthesizing it again", async ({ page }) => {
  const ident = "job_" + "d".repeat(32);
  const inputs: string[] = [];
  let references = 0;
  await page.route("**/api/generate-speech", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { connected: true } });
    inputs.push(route.request().postDataJSON().input);
    return inputs.length === 1
      ? route.fulfill({ status: 202, json: { id: ident, status: "queued" } })
      : route.fulfill({ status: 503, json: { error: "Stop before the next sentence" } });
  });
  await page.route(`**/api/speech-jobs/${ident}`, (route) =>
    route.fulfill({ json: { id: ident, status: "completed" } }));
  await page.route(`**/api/speech-jobs/${ident}/content`, (route) =>
    route.fulfill({ contentType: "audio/wav", body: Buffer.from("stable-first-wave") }));
  await page.route("**/api/voice-reference", (route) => {
    references++;
    return references === 1
      ? route.fulfill({ status: 503, json: { error: "Reference upload failed" } })
      : route.fulfill({ json: { voiceAssetId: "reference-retry" } });
  });
  await page.goto("/voice");
  const generate = page.getByRole("button", { name: "声を生成（5本）", exact: true });
  await generate.click();
  await expect.poll(() => references).toBe(1);
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect.poll(() => references).toBe(2);
  await expect.poll(() => inputs.length).toBe(2);
  expect(inputs[0]).not.toBe(inputs[1]);
  await page.getByRole("button", { name: "前の文章へ" }).click();
  await expect(page.getByLabel("学習前の声 1を再生", { exact: true })).toBeVisible();
});
