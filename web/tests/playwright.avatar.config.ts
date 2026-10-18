import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /avatar-poses\.spec\.ts/,
  outputDir: "../../test-results/avatar",
  use: { baseURL: "http://localhost:3000" },
  webServer: {
    command: "node scripts/start-next.mjs dev",
    cwd: "..",
    url: "http://localhost:3000/avatar",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
