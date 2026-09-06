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
 *   node scripts/user.mjs --show     someone@example.com
 *   node scripts/user.mjs --unsuspend someone@example.com --remote
 *   node scripts/user.mjs --suspend  someone@example.com --remote
 */

const DATABASE = "rabblebabble";
const ACTIONS = ["show", "suspend", "unsuspend"];

const remote = process.argv.includes("--remote");
const action = ACTIONS.find((name) => process.argv.includes(`--${name}`));
const email = process.argv.slice(2).find((argument) => !argument.startsWith("--"));

if (action === undefined || email === undefined) {
  console.error("Usage: node scripts/user.mjs --show|--suspend|--unsuspend <email> [--remote]");
  process.exit(2);
}

const normalised = email.trim().toLowerCase();

// Parameterised, not interpolated. invite.mjs doubled quotes by hand, which is
// one review away from being wrong on a value someone else chose.
const statements = {
  show: "SELECT id, email, status, created_at, last_seen_at FROM users WHERE email = ?1;",
  suspend: "UPDATE users SET status = 'suspended' WHERE email = ?1;",
  unsuspend: "UPDATE users SET status = 'active' WHERE email = ?1;",
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
      remote ? "--remote" : "--local",
      "--file",
      JSON.stringify(sqlPath),
      "--param",
      JSON.stringify(normalised),
    ],
    { stdio: "inherit", shell: true },
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("");
console.log(`${action}: ${normalised}   Target: ${remote ? "production" : "local"}`);
