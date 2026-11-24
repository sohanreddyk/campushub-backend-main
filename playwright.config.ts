import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E configuration for CampusHub (Lab 9).
 *
 * `webServer` boots the whole stack before the first test:
 *   1. the Express API on :3000, backed by a throwaway in-memory MongoDB that
 *      is seeded with known resources (e2e/support/start-backend.ts), and
 *   2. the Vite dev server on :5173, which proxies /api to the API.
 *
 * Tests run one at a time because they share that single database; each test
 * resets it first (POST http://127.0.0.1:3100/reset), so they are independent.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",

  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env["CI"] !== undefined,

  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: "http://localhost:5173",
    // Fixed locale so date/time text is the same on every machine.
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],

  webServer: [
    {
      // Compile the backend, then run it against an in-memory MongoDB.
      // Always start fresh: a leftover server would hold stale data.
      command: "npm run build && node e2e/support/start-backend.ts",
      url: "http://localhost:3000/api/v1/resources",
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run dev --prefix client",
      url: "http://localhost:5173",
      reuseExistingServer: process.env["CI"] === undefined,
      timeout: 120_000,
    },
  ],
});
