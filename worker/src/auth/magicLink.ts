import { randomToken, safeEqualHex, sha256Hex } from "./crypto";

export interface MagicLinkToken {
  readonly token: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export type ConsumeFailure = "link-invalid" | "link-expired" | "link-consumed" | "link-wrong-device";

export type ConsumeResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: ConsumeFailure };

/**
 * Issues a single-use sign-in token and the device nonce that binds it.
 *
 * Any outstanding tokens for the user are consumed first, so asking for a new
 * link invalidates the old one rather than leaving several live at once.
 */
export async function issueMagicLink(
  db: D1Database,
  userId: string,
  nowSeconds: number,
  ttlSeconds: number,
  ipHash: string | null,
): Promise<MagicLinkToken> {
  const token = randomToken();
  const nonce = randomToken();
  const expiresAt = nowSeconds + ttlSeconds;

  await db.batch([
    db
      .prepare("UPDATE auth_tokens SET consumed_at = ?1 WHERE user_id = ?2 AND consumed_at IS NULL")
      .bind(nowSeconds, userId),
    db
      .prepare(
        `INSERT INTO auth_tokens (token_hash, user_id, request_nonce_hash, request_ip_hash, created_at, expires_at, consumed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`,
      )
      .bind(await sha256Hex(token), userId, await sha256Hex(nonce), ipHash, nowSeconds, expiresAt),
  ]);

  return { token, nonce, expiresAt };
}

/**
 * Redeems a token exactly once.
 *
 * The single-use guarantee is the conditional UPDATE, not a read followed by a
 * write: two simultaneous redemptions both run the statement, and SQLite lets
 * exactly one of them match `consumed_at IS NULL`.
 */
export async function consumeMagicLink(
  db: D1Database,
  token: string,
  nowSeconds: number,
  options: { readonly nonce: string | null; readonly requireSameDevice: boolean },
): Promise<ConsumeResult> {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT user_id, request_nonce_hash, expires_at, consumed_at
         FROM auth_tokens WHERE token_hash = ?1`,
    )
    .bind(tokenHash)
    .first<{
      user_id: string;
      request_nonce_hash: string | null;
      expires_at: number;
      consumed_at: number | null;
    }>();

  if (row === null) {
    return { ok: false, reason: "link-invalid" };
  }
  if (row.consumed_at !== null) {
    return { ok: false, reason: "link-consumed" };
  }
  if (row.expires_at <= nowSeconds) {
    return { ok: false, reason: "link-expired" };
  }

  // Stops a forwarded email being redeemed by whoever received it.
  if (options.requireSameDevice && row.request_nonce_hash !== null) {
    if (options.nonce === null) {
      return { ok: false, reason: "link-wrong-device" };
    }
    if (!safeEqualHex(await sha256Hex(options.nonce), row.request_nonce_hash)) {
      return { ok: false, reason: "link-wrong-device" };
    }
  }

  const claimed = await db
    .prepare(
      `UPDATE auth_tokens SET consumed_at = ?1
        WHERE token_hash = ?2 AND consumed_at IS NULL
        RETURNING user_id`,
    )
    .bind(nowSeconds, tokenHash)
    .first<{ user_id: string }>();

  if (claimed === null) {
    // Someone else won the race between the read above and this update.
    return { ok: false, reason: "link-consumed" };
  }

  return { ok: true, userId: claimed.user_id };
}
