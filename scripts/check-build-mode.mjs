import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/**
 * Asserts that each build really does exclude the other mode's code.
 *
 * This is not about bundle size. The hosted build must contain no code path
 * that sends audio to Groq with a user-supplied key, and "usually tree-shaken"
 * is not a good enough guarantee for that. A regression here would be silent,
 * so it is checked rather than assumed.
 *
 * Usage: node scripts/check-build-mode.mjs <service|byok> [distDir]
 */

const FORBIDDEN = {
  service: [
    // The direct-to-Groq endpoint. Its presence means the Groq adapter, and
    // its Bearer-token code path, survived into the hosted bundle.
    "api.groq.com",
  ],
  byok: [
    // Auth surface has no business in the no-infrastructure build.
    "/v1/me",
    "/auth/request-link",
    // The sign-in screen itself, which can never render here.
    "Sign in to RabbleBabble",
  ],
};

const mode = process.argv[2];
const distDir = process.argv[3] ?? "dist";

if (mode !== "service" && mode !== "byok") {
  console.error("Usage: node scripts/check-build-mode.mjs <service|byok> [distDir]");
  process.exit(2);
}

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (path.endsWith(".js") || path.endsWith(".html")) {
      yield path;
    }
  }
}

const failures = [];
for (const path of walk(distDir)) {
  const contents = readFileSync(path, "utf8");
  for (const needle of FORBIDDEN[mode]) {
    if (contents.includes(needle)) {
      failures.push(`${path} contains "${needle}"`);
    }
  }
}

if (failures.length > 0) {
  console.error(`The ${mode} build leaked code from the other mode:`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error("\nSomething outside a folded `if (SERVICE_MODE)` branch is importing the wrong adapter.");
  process.exit(1);
}

console.log(`OK: the ${mode} build contains none of ${FORBIDDEN[mode].map((value) => `"${value}"`).join(", ")}`);
