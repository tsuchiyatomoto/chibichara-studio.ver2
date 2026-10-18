import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /voice-.*\.spec\.ts/,
  outputDir: "../../test-results/voice",
  use: { baseURL: "http://localhost:3000" },
  webServer: {
    command: "node scripts/start-next.mjs dev",
    cwd: "..",
    url: "http://localhost:3000/voice",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
