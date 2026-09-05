import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";

// TEST_MIGRATIONS is injected as a binding by worker/vitest.config.ts. It is
// cast here rather than declared on Env so the production Env type stays honest
// about what actually exists in a deployed Worker.
const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };

// Storage is isolated per test file, so this runs against a fresh database
// every time and cases cannot leak state into one another.
await applyD1Migrations(env.DB, TEST_MIGRATIONS);
