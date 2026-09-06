import { randomToken, sha256Hex } from "./crypto";

/**
 * Sessions are opaque random tokens, not JWTs.
 *
 * There is no signing key to rotate, no algorithm-confusion class of bug, and
 * revoking one is a DELETE rather than a blocklist. Single-use enforcement
 * would need a database row anyway, so the row may as well be the token.
 *
 * The __Host- prefix is browser-enforced: the cookie is rejected unless it is
 * Secure, Path=/ and carries no Domain. That is exactly the shape wanted here,
 * policed by the browser rather than by our own care.
 */

export const SESSION_COOKIE = "__Host-rb_session";
export const LINK_NONCE_COOKIE = "__Host-rb_link";

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly audioSecondsOverride: number | null;
}

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: number;
}

export async function issueSession(
  db: D1Database,
  userId: string,
  nowSeconds: number,
  ttlSeconds: number,
): Promise<IssuedSession> {
  const token = randomToken();
  const expiresAt = nowSeconds + ttlSeconds;

  await db
    .prepare(
      `INSERT INTO sessions (session_hash, user_id, created_at, expires_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?3)`,
    )
    .bind(await sha256Hex(token), userId, nowSeconds, expiresAt)
    .run();

  return { token, expiresAt };
}

export async function readSession(
  db: D1Database,
  token: string,
  nowSeconds: number,
): Promise<SessionUser | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.status, u.audio_seconds_override, s.last_seen_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.session_hash = ?1 AND s.expires_at > ?2`,
    )
    .bind(await sha256Hex(token), nowSeconds)
    .first<{
      id: string;
      email: string;
      status: string;
      audio_seconds_override: number | null;
      last_seen_at: number;
    }>();

  if (row === null) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    status: row.status,
    audioSecondsOverride: row.audio_seconds_override,
  };
}

/**
 * Written at most once a day, and it is what makes the 90-day expiry sliding.
 *
 * Authentication happens on every request, so a write per request would turn a
 * read-only check into D1 write load for a timestamp nobody reads that
 * precisely. Riding the expiry extension on the same once-a-day write costs
 * nothing extra: a daily user is never signed out, and an abandoned phone
 * stops being a key 90 days after it was last used rather than 365 days after
 * it was first signed in.
 */
export function touchSession(
  db: D1Database,
  token: string,
  nowSeconds: number,
  ttlSeconds: number,
): Promise<unknown> {
  return sha256Hex(token).then((hash) =>
    db
      .prepare(
        `UPDATE sessions
            SET last_seen_at = ?1,
                expires_at   = ?1 + ?4
          WHERE session_hash = ?2 AND last_seen_at < ?3`,
      )
      .bind(nowSeconds, hash, nowSeconds - 86_400, ttlSeconds)
      .run(),
  );
}

export async function revokeSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE session_hash = ?1").bind(await sha256Hex(token)).run();
}

export async function revokeAllSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId).run();
}

export function serializeSessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function serializeLinkNonceCookie(nonce: string, maxAgeSeconds: number): string {
  return [
    `${LINK_NONCE_COOKIE}=${nonce}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function clearedLinkNonceCookie(): string {
  return `${LINK_NONCE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}
