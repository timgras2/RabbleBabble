import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * The recovery path for a suspended account.
 *
 * The Worker can suspend an account by itself, and until this existed there
 * was no way back: no admin endpoint, no CLI, nothing in the repo. Recovery
 * meant hand-writing a `wrangler d1 execute --remote` and getting the quoting
 * right on the first try, against production.
 *
 * Usage:
 *   node scripts/user.mjs --show      someone@example.com
 *   node scripts/user.mjs --unsuspend someone@example.com --remote
 *   node scripts/user.mjs --suspend   someone@example.com --remote
 *   node scripts/user.mjs --show      someone@example.com --staging
 */

/**
 * Which deployment to act on.
 *
 * Staging is a separate Worker with a separate D1 database, so an admin
 * command that cannot reach it means staging cannot be signed into -- and a
 * staging environment nobody can sign into is not a staging environment.
 */
function target() {
  if (process.argv.includes("--staging")) {
    return { database: "rabblebabble-staging", env: ["--env", "staging"], label: "staging" };
  }
  const remote = process.argv.includes("--remote");
  return { database: "rabblebabble", env: [], label: remote ? "production" : "local" };
}


/**
 * SQL string literals, the only way `wrangler d1 execute` allows.
 *
 * It takes `--command` or `--file` and has no parameter binding at all, so
 * "just use bound parameters" is not on the table. Two defences instead:
 * every value is validated against a strict pattern before it gets here, and
 * quoting still doubles any single quote. Belt and braces, because the failure
 * mode is SQL injection into an admin command run against production.
 */
function sqlString(value) {
  if (typeof value !== "string") {
    throw new TypeError("sqlString expects a string");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

const ACTIONS = ["show", "suspend", "unsuspend"];

const remote = process.argv.includes("--remote") || process.argv.includes("--staging");
const { database: DATABASE, env: ENV_FLAGS, label: TARGET } = target();
const action = ACTIONS.find((name) => process.argv.includes(`--${name}`));
const email = process.argv.slice(2).find((argument) => !argument.startsWith("--"));

if (action === undefined || email === undefined) {
  console.error(
    "Usage: node scripts/user.mjs --show|--suspend|--unsuspend <email> [--remote|--staging]",
  );
  process.exit(2);
}

const normalised = email.trim().toLowerCase();

// Validated before it is ever quoted. This mirrors isPlausibleEmail in
// worker/src/db/users.ts: no whitespace, no quotes, one @, a real-looking
// domain. A value that fails this cannot become SQL at all.
if (!/^[^\s@'"\\;]+@[^\s@.'"\\;]+(\.[^\s@.'"\\;]+)+$/.test(normalised) || normalised.length > 254) {
  console.error(`Not a plausible email address: ${email}`);
  process.exit(2);
}

const target_email = sqlString(normalised);
const statements = {
  show: `SELECT id, email, status, created_at, last_seen_at FROM users WHERE email = ${target_email};`,
  suspend: `UPDATE users SET status = 'suspended' WHERE email = ${target_email};`,
  unsuspend: `UPDATE users SET status = 'active' WHERE email = ${target_email};`,
};

const directory = mkdtempSync(join(tmpdir(), "rb-user-"));
const sqlPath = join(directory, "user.sql");
writeFileSync(sqlPath, statements[action]);

try {
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DATABASE,
      ...ENV_FLAGS,
      remote ? "--remote" : "--local",
      "--file",
      JSON.stringify(sqlPath),
    ],
    { stdio: "inherit", shell: true },
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("");
console.log(`${action}: ${normalised}   Target: ${TARGET}`);
