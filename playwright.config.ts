import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

// CI/sandbox images may pre-install a Chromium at a pinned path; use it when
// present instead of downloading a new browser.
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  ?? (existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // shared local D1 state — keep flows deterministic
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: "bash scripts/e2e-server.sh",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
