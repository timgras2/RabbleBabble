import { readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/**
 * A budget, not a measurement.
 *
 * This app's whole promise is tap -> speak -> tap -> text, and on the mobile
 * data connection it is actually used on, the first paint is the slowest part
 * of that. A number that only gets reported drifts upward; a number that fails
 * the build has to be argued with.
 *
 * Raising a limit here is fine -- but it should be a deliberate commit that
 * says why, which is the entire point.
 */
const ASSETS = "dist/assets";

const BUDGETS = [
  // React and the app shell. Everything first paint genuinely needs.
  { pattern: /^index-.*\.js$/, gzipKb: 85, label: "entry chunk" },
  { pattern: /^index-.*\.css$/, gzipKb: 8, label: "stylesheet" },
  // Lazy, so it only costs anyone who opens it. SignInScreen is deliberately
  // NOT lazy -- see the comment on its import in App.tsx.
  { pattern: /^SettingsScreen-.*\.js$/, gzipKb: 10, label: "settings screen" },
];

let failed = false;

for (const budget of BUDGETS) {
  const matches = readdirSync(ASSETS).filter((name) => budget.pattern.test(name));
  if (matches.length === 0) {
    console.error(`FAIL: no ${budget.label} matched ${String(budget.pattern)}`);
    failed = true;
    continue;
  }

  for (const name of matches) {
    const path = join(ASSETS, name);
    const gzipKb = gzipSync(readFileSync(path)).length / 1024;
    const raw = statSync(path).size / 1024;
    const verdict = gzipKb <= budget.gzipKb ? "ok" : "FAIL";
    console.log(
      `${verdict}: ${budget.label} ${name} ${gzipKb.toFixed(1)} kB gzip (budget ${budget.gzipKb}, raw ${raw.toFixed(1)})`,
    );
    if (gzipKb > budget.gzipKb) {
      failed = true;
    }
  }
}

if (failed) {
  console.error("");
  console.error("Bundle budget exceeded. Either trim it, or raise the budget in this file and say why.");
  process.exit(1);
}
