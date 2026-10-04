import { expect, test } from "@playwright/test";

const responses = [
  {
    name: "HTML 404",
    status: 404,
    contentType: "text/html",
    body: "<!DOCTYPE html><html><body>Not Found</body></html>",
  },
  {
    name: "HTML 502",
    status: 502,
    contentType: "text/html",
    body: "<!DOCTYPE html><html><body>Bad Gateway</body></html>",
  },
  {
    name: "malformed JSON",
    status: 200,
    contentType: "application/json",
    body: '{"status":',
  },
];

for (const { name, status, contentType, body } of responses) {
  test(`Movie explains an invalid response: ${name}`, async ({ page }) => {
    await page.route("**/api/movie/**", (route) =>
      route.fulfill({ status, contentType, body }),
    );
    await page.goto("http://localhost:3000/movie");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      `動画処理サーバーから正しい応答を取得できませんでした（HTTP ${status}）。ページを再読み込みして、もう一度お試しください。`,
    );
    await expect(
      page.getByRole("button", { name: "MP4を選択", exact: true }),
    ).toBeDisabled();
  });
}

for (const field of ["error", "detail"]) {
  test(`Movie preserves the server's JSON ${field} message`, async ({ page }) => {
    const message = "動画処理サーバーに接続できません。";
    await page.route("**/api/movie/**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ [field]: message }),
      }),
    );
    await page.goto("http://localhost:3000/movie");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(message);
  });
}
