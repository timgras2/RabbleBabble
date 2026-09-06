import { sha256Hex } from "./crypto";

/**
 * Invite codes are stored hashed, like every other credential here: a database
 * read should not hand out free signups. They are 12 characters from an
 * alphabet with no I, L, O, 0 or 1, because someone will read one aloud.
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateInviteCode(): string {
  const characters = [...Array<undefined>(12)].map(() => ALPHABET[unbiasedIndex(ALPHABET.length)] ?? "X");
  return [characters.slice(0, 4).join(""), characters.slice(4, 8).join(""), characters.slice(8, 12).join("")].join("-");
}

/**
 * Rejection sampling. 256 is not a multiple of 31, so `byte % 31` makes the
 * first ten letters of the alphabet meaningfully likelier than the rest.
 */
function unbiasedIndex(range: number): number {
  const ceiling = 256 - (256 % range);
  const byte = new Uint8Array(1);
  do {
    crypto.getRandomValues(byte);
  } while (byte[0]! >= ceiling);
  return byte[0]! % range;
}

export function normaliseInviteCode(value: string): string {
  return value.trim().toUpperCase().replaceAll("-", "").replaceAll(" ", "");
}

export function hashInviteCode(value: string): Promise<string> {
  return sha256Hex(normaliseInviteCode(value));
}

/**
 * Checks a code without spending it. Called before any user lookup, so the
 * answer cannot depend on whether an account exists.
 */
export async function isInviteUsable(db: D1Database, code: string, nowSeconds: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT max_uses, uses, expires_at, disabled_at FROM invite_codes WHERE code_hash = ?1")
    .bind(await hashInviteCode(code))
    .first<{ max_uses: number; uses: number; expires_at: number | null; disabled_at: number | null }>();

  if (row === null || row.disabled_at !== null) {
    return false;
  }
  if (row.expires_at !== null && row.expires_at <= nowSeconds) {
    return false;
  }
  return row.uses < row.max_uses;
}

/**
 * Spends a use, atomically. Burning a code requires already holding a valid
 * one, so it is spent at link-request time rather than at redemption.
 */
export async function consumeInvite(db: D1Database, code: string, nowSeconds: number): Promise<boolean> {
  const claimed = await db
    .prepare(
      `UPDATE invite_codes SET uses = uses + 1
        WHERE code_hash = ?1
          AND disabled_at IS NULL
          AND uses < max_uses
          AND (expires_at IS NULL OR expires_at > ?2)
        RETURNING uses`,
    )
    .bind(await hashInviteCode(code), nowSeconds)
    .first<{ uses: number }>();

  return claimed !== null;
}
