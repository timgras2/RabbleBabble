import { defineConfig, devices } from "@playwright/test";

/**
 * One test, against real build output.
 *
 * `vite preview` serves dist/ -- the actual bundle, the actual service worker
 * registration, the actual CSP meta tag -- rather than a dev server with
 * different module semantics. The point is to catch the class of bug the unit
 * tests structurally cannot: something that only breaks once the code has been
 * bundled and served.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    // HTTPS, because vite.config.mjs loads basicSsl -- and because getUserMedia
    // and the clipboard are secure-context-only anyway, so a plain-http
    // preview would not be testing the app as it is served.
    baseURL: "https://localhost:4173",
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
  },
  projects: [
    {
      // The one platform this app targets.
      name: "android-chrome",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    // BYOK mode: the hosted build would sit behind a sign-in wall that needs a
    // Worker, a database and a mailbox. The recorder screen -- which is what
    // this test is about -- is the same component either way.
    command: "npm run build:byok && npx vite preview --config src/vite.config.mjs --mode byok --port 4173",
    url: "https://localhost:4173",
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
