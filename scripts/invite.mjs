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
 *   node scripts/invite.mjs --staging        # the staging Worker's database
 *   node scripts/invite.mjs --uses 3 --label "family"
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0 or 1

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

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function generateCode() {
  const characters = [...Array(12)].map(() => ALPHABET[unbiasedIndex(ALPHABET.length)]);
  return [characters.slice(0, 4).join(""), characters.slice(4, 8).join(""), characters.slice(8, 12).join("")].join("-");
}

/**
 * Rejection sampling, matching worker/src/auth/invites.ts. 256 is not a
 * multiple of 31, so `byte % 31` makes the first ten letters of the alphabet
 * meaningfully likelier than the rest.
 */
function unbiasedIndex(range) {
  const ceiling = 256 - (256 % range);
  let byte;
  do {
    byte = randomBytes(1)[0];
  } while (byte >= ceiling);
  return byte % range;
}

const remote = process.argv.includes("--remote") || process.argv.includes("--staging");
const { database: DATABASE, env: ENV_FLAGS, label: TARGET } = target();
const maxUses = Number(argument("uses", "1"));
const label = argument("label", "invite");

if (!Number.isSafeInteger(maxUses) || maxUses < 1) {
  console.error("--uses must be a positive integer");
  process.exit(2);
}

// A label is free text the operator chose, so it is the one value here that
// could carry anything. Restricted to something a human would actually type.
if (!/^[\w .,'()-]{1,60}$/.test(label)) {
  console.error("--label must be 1-60 characters of letters, digits, spaces or . , ' ( ) -");
  process.exit(2);
}

const code = generateCode();
// Must match hashInviteCode in worker/src/auth/invites.ts: uppercase, no dashes.
const normalised = code.replaceAll("-", "").toUpperCase();
const hash = createHash("sha256").update(normalised).digest("hex");
const now = Math.floor(Date.now() / 1000);

// `wrangler d1 execute` has no parameter binding, so this interpolates -- but
// only after the label has been validated above, and the hash is 64 hex
// characters by construction. sqlString still doubles any quote.
const sql =
  "INSERT INTO invite_codes (code_hash, label, max_uses, uses, expires_at, created_at, disabled_at) " +
  `VALUES (${sqlString(hash)}, ${sqlString(label)}, ${maxUses}, 0, NULL, ${now}, NULL);`;

// Written to a file rather than passed with --command: the shell needed to
// resolve npx on Windows would otherwise word-split the SQL.
const directory = mkdtempSync(join(tmpdir(), "rb-invite-"));
const sqlPath = join(directory, "invite.sql");
writeFileSync(sqlPath, sql);

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
console.log(`Invite code: ${code}`);
console.log(`Uses: ${maxUses}   Target: ${TARGET}`);
console.log("This is the only time it is shown. The database stores only its hash.");
