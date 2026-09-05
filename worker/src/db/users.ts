export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly audio_seconds_override: number | null;
}

/** Emails are stored trimmed and lower-cased, so lookups are unambiguous. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

const EMAIL_PATTERN = new RegExp("^[^@]+@[^@.]+([.][^@.]+)+$");
const WHITESPACE = [" ", String.fromCharCode(9), String.fromCharCode(10), String.fromCharCode(13)];

export function isPlausibleEmail(value: string): boolean {
  if (value.length < 3 || value.length > 254) {
    return false;
  }
  if (WHITESPACE.some((character) => value.includes(character))) {
    return false;
  }
  return EMAIL_PATTERN.test(value);
}

export function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db
    .prepare("SELECT id, email, status, audio_seconds_override FROM users WHERE email = ?1")
    .bind(email)
    .first<UserRow>();
}

export async function createUser(
  db: D1Database,
  email: string,
  nowSeconds: number,
  inviteCodeHash: string | null,
): Promise<UserRow> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO users (id, email, status, invite_code_hash, audio_seconds_override, created_at, last_seen_at)
       VALUES (?1, ?2, 'active', ?3, NULL, ?4, NULL)`,
    )
    .bind(id, email, inviteCodeHash, nowSeconds)
    .run();

  return { id, email, status: "active", audio_seconds_override: null };
}

export function suspendUser(db: D1Database, userId: string): Promise<unknown> {
  return db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(userId).run();
}
