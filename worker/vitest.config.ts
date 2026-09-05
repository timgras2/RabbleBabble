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
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      name: "worker",
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup/applyMigrations.ts"],
      restoreMocks: true,
    },
  };
});
