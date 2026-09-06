import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject(async () => {
  // Worker tests run against a real D1, migrated per test file, so quota and
  // single-use-token behaviour is proven against SQLite rather than a mock
  // that agrees with whatever the code happens to do.
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "../wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Pinned so the suite does not depend on a developer's .dev.vars,
            // which CI does not have and which readConfig requires. Every test
            // injects its own fetcher and its own mailer, so these values are
            // never used - they only have to satisfy readConfig.
            GROQ_API_KEY: "test-groq-key",
            RESEND_API_KEY: "test-resend-key",
            IP_HASH_PEPPER: "dGVzdC1wZXBwZXItbm90LWEtc2VjcmV0LTAwMDAwMDA=",
            // Pinned for the same reason the harness pins appOrigin: pointing
            // the deployed config at a real domain and a real mailer must not
            // change what the suite exercises.
            APP_ORIGIN: "http://localhost:8787",
            EMAIL_MODE: "console",
          },
        },
      }),
    ],
    test: {
      name: "worker",
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup/applyMigrations.ts"],
      restoreMocks: true,
      // Each test file boots its own workerd instance. Starting several at
      // once on Windows outruns the pool startup timeout, so they run in
      // sequence - slower, but it actually finishes.
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
