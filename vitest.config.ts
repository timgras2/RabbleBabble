import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Vitest does not load src/vite.config.mjs, so the build-mode constants
        // are declared again here. No test may depend on their values: anything
        // mode-specific takes the mode as an argument instead.
        define: {
          __RB_SERVICE_MODE__: "true",
          __RB_API_BASE_URL__: JSON.stringify(""),
        },
        test: {
          name: "app",
          environment: "jsdom",
          globals: true,
          restoreMocks: true,
          include: ["src/**/*.test.{ts,tsx}"],
        },
      },
      "./worker/vitest.config.ts",
    ],
  },
});
