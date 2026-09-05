import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vitest does not load src/vite.config.mjs, so the build-mode constants have
  // to be declared again here. No test may depend on their values: anything
  // mode-specific takes the mode as an argument instead.
  define: {
    __RB_SERVICE_MODE__: "true",
    __RB_API_BASE_URL__: JSON.stringify(""),
  },
  test: {
    environment: "jsdom",
    globals: true,
    restoreMocks: true,
  },
});
