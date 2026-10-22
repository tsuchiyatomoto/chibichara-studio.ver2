import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const width of [1440, 390]) {
  test(`navigation shows loading while the next page is unavailable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/**", (route) => route.fulfill({ json: {
      connected: true, speakerInversion: { ready: true, min_samples: 5 }, data: [],
    } }));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let waiting = 0;
    await page.route("**/voice?**", async (route) => {
      if (route.request().headers().rsc === "1") {
        waiting++;
        await held;
      }
      await route.continue();
    });
    try {
      await page.goto("/avatar");
      await page.waitForLoadState("networkidle");
      const menu = page.getByRole("navigation", { name: width >= 768 ? "制作機能" : "スタジオメニュー" });
      await menu.getByRole("link", { name: "Voice", exact: true }).click();
      await expect.poll(() => waiting).toBeGreaterThan(0);
      const loading = page.getByRole("status").filter({ hasText: "読み込み中…" });
      await expect(loading.first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("navigation-loading.png") });
      release();
      await expect(page).toHaveURL(/\/voice$/);
      await expect(loading).toHaveCount(0);
    } finally {
      release();
    }
  });
}

const appOrigin = "https://chibichara-studio-prototype.onrender.com";
const readyUrl = `${appOrigin}/api/ready`;

async function serveLauncher(page: Page) {
  await page.route("http://localhost:3000/launcher/**", (route) => {
    const script = new URL(route.request().url()).pathname === "/launcher/start.js";
    return route.fulfill({
      contentType: script ? "text/javascript" : "text/html",
      body: readFileSync(join(__dirname, "../launcher", script ? "start.js" : "index.html")),
    });
  });
  await page.route(`${appOrigin}/avatar`, (route) => route.fulfill({ contentType: "text/html", body: "<p>Avatar</p>" }));
  await page.route(`${appOrigin}/movie`, (route) => route.fulfill({ contentType: "text/html", body: "<p>Movie</p>" }));
}

test("the entry page stays visible through startup responses and opens the ready app without cookies", async ({ page }, testInfo) => {
  await serveLauncher(page);
  await page.context().addCookies([{ name: "test-owner", value: "must-not-send", url: appOrigin }]);
  let attempts = 0;
  await page.route(readyUrl, async (route) => {
    expect((await route.request().allHeaders()).cookie).toBeUndefined();
    attempts++;
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (attempts === 1) return route.fulfill({ status: 503, headers, body: "Starting" });
    if (attempts === 2) return route.fulfill({ contentType: "text/html", headers, body: "Starting" });
    return route.fulfill({ headers, json: { service: "chibichara-studio", ready: true } });
  });
  await page.goto("/launcher/");
  await expect(page.getByRole("status")).toHaveText("読み込み中…");
  await expect(page.getByText("初回は約1分", { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("entry-loading.png") });
  await expect(page).toHaveURL(`${appOrigin}/avatar`, { timeout: 15000 });
  expect(attempts).toBe(3);
});

test("the entry page stops checking after two minutes and offers a working retry", async ({ page }) => {
  await page.clock.install();
  await serveLauncher(page);
  let ready = false;
  let attempts = 0;
  await page.route(readyUrl, (route) => {
    attempts++;
    return route.fulfill({ status: ready ? 200 : 503, headers: { "Access-Control-Allow-Origin": "*" },
      json: { service: "chibichara-studio", ready } });
  });
  await page.goto("/launcher/?next=/movie");
  await expect.poll(() => attempts).toBeGreaterThan(0);
  await page.clock.runFor(124000);
  await expect(page.getByRole("status")).toHaveText("接続に時間がかかっています");
  const afterTimeout = attempts;
  await page.clock.runFor(30000);
  expect(attempts).toBe(afterTimeout);
  ready = true;
  await page.getByRole("button", { name: "もう一度試す" }).click();
  await expect(page).toHaveURL(`${appOrigin}/movie`);
});

test("the entry page rejects an external redirect destination", async ({ page }) => {
  await serveLauncher(page);
  await page.route(readyUrl, (route) => route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" },
    json: { service: "chibichara-studio", ready: true } }));
  await page.goto("/launcher/?next=https://example.com");
  await expect(page).toHaveURL(`${appOrigin}/avatar`);
});

test("readiness can be checked across origins without an owner cookie or a GPU connection", async ({ request }) => {
  const response = await request.get("/api/ready", { headers: { Origin: "https://entry.example" } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ service: "chibichara-studio", ready: true });
  expect(response.headers()["access-control-allow-origin"]).toBe("*");
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["set-cookie"]).toBeUndefined();
});
