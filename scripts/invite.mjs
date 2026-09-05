import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * Mints an invite code and stores its hash.
 *
 * A CLI rather than an admin endpoint: an authenticated admin surface is more
 * attack surface than a command run a handful of times a year, and the code
 * itself is only ever printed here - the database keeps a hash, so a database
 * read cannot hand out free signups.
 *
 * Usage:
 *   node scripts/invite.mjs                  # local database
 *   node scripts/invite.mjs --remote         # production
 *   node scripts/invite.mjs --uses 3 --label "family"
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0 or 1
const DATABASE = "rabblebabble";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function generateCode() {
  const bytes = randomBytes(12);
  const characters = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]);
  return [characters.slice(0, 4).join(""), characters.slice(4, 8).join(""), characters.slice(8, 12).join("")].join("-");
}

const remote = process.argv.includes("--remote");
const maxUses = Number(argument("uses", "1"));
const label = argument("label", "invite");

if (!Number.isSafeInteger(maxUses) || maxUses < 1) {
  console.error("--uses must be a positive integer");
  process.exit(2);
}

const code = generateCode();
// Must match hashInviteCode in worker/src/auth/invites.ts: uppercase, no dashes.
const normalised = code.replaceAll("-", "").toUpperCase();
const hash = createHash("sha256").update(normalised).digest("hex");
const now = Math.floor(Date.now() / 1000);

const sql =
  "INSERT INTO invite_codes (code_hash, label, max_uses, uses, expires_at, created_at, disabled_at) " +
  `VALUES ('${hash}', '${label.replaceAll("'", "''")}', ${maxUses}, 0, NULL, ${now}, NULL);`;

// Written to a file rather than passed with --command: the shell needed to
// resolve npx on Windows would otherwise word-split the SQL.
const directory = mkdtempSync(join(tmpdir(), "rb-invite-"));
const sqlPath = join(directory, "invite.sql");
writeFileSync(sqlPath, sql);

try {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DATABASE, remote ? "--remote" : "--local", "--file", JSON.stringify(sqlPath)],
    { stdio: "inherit", shell: true },
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("");
console.log(`Invite code: ${code}`);
console.log(`Uses: ${maxUses}   Target: ${remote ? "production" : "local"}`);
console.log("This is the only time it is shown. The database stores only its hash.");
