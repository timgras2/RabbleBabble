import type { Config } from "../config";
import { rateLimited } from "../errors";
import { utcDay } from "./clock";
import { reserveMicrosForChat, reserveMicrosForTranscription } from "./pricing";

export interface Reservation {
  readonly id: string;
  readonly userId: string;
  readonly day: string;
  readonly audioSeconds: number;
  readonly micros: number;
}

export interface UsageRow {
  readonly audio_seconds: number;
  readonly audio_seconds_reserved: number;
  readonly transcribe_calls: number;
  readonly chat_calls: number;
}

const RESERVATION_TTL_SECONDS = 600;

/**
 * Budget is taken before the money is spent and settled on what was actually
 * used. Two rules make this safe on D1, which has no interactive transactions:
 *
 * - Every reservation is an atomic compare-and-increment. SQLite skips the
 *   DO UPDATE when the WHERE is false, and RETURNING only emits rows that were
 *   really written, so there is no read-then-write race to lose.
 * - Anything that fails, including a thrown D1 error, fails CLOSED. Refusing a
 *   request costs a retry; forwarding one past the cap costs money.
 */
export async function reserveTranscription(
  db: D1Database,
  config: Config,
  userId: string,
  nowSeconds: number,
  audioSecondsLimit: number,
): Promise<Reservation> {
  const day = utcDay(nowSeconds);
  const audioSeconds = config.transcribeReserveSeconds;
  const micros = reserveMicrosForTranscription(audioSeconds, config.priceTranscribeMicrosPerHour);

  // SQLite does not evaluate the ON CONFLICT ... WHERE guard on the INSERT
  // path, so the first request of a day would otherwise slip past a limit it
  // already exceeds on its own.
  if (audioSeconds > audioSecondsLimit) {
    throw quotaExceeded();
  }
  if (micros > config.globalDailySpendMicros) {
    throw spendCapReached();
  }

  await reserveGlobal(db, day, micros, config.globalDailySpendMicros, nowSeconds);

  const reservation: Reservation = { id: crypto.randomUUID(), userId, day, audioSeconds, micros };
  const reserved = await db
    .prepare(
      `INSERT INTO usage_daily (user_id, day, audio_seconds, audio_seconds_reserved,
                                transcribe_calls, chat_calls, chat_tokens_in, chat_tokens_out, updated_at)
       VALUES (?1, ?2, 0, ?3, 1, 0, 0, 0, ?4)
       ON CONFLICT(user_id, day) DO UPDATE SET
         audio_seconds_reserved = usage_daily.audio_seconds_reserved + ?3,
         transcribe_calls       = usage_daily.transcribe_calls + 1,
         updated_at             = ?4
       WHERE usage_daily.audio_seconds + usage_daily.audio_seconds_reserved + ?3 <= ?5
         AND usage_daily.transcribe_calls + 1 <= ?6
       RETURNING transcribe_calls`,
    )
    .bind(userId, day, audioSeconds, nowSeconds, audioSecondsLimit, config.userDailyTranscribeCalls)
    .first<{ transcribe_calls: number }>();

  if (reserved === null) {
    // The user is over their own limit, so give the global budget back.
    await releaseGlobal(db, day, micros, nowSeconds);
    throw quotaExceeded();
  }

  await recordReservation(db, reservation, nowSeconds);
  return reservation;
}

export async function reserveChat(
  db: D1Database,
  config: Config,
  userId: string,
  nowSeconds: number,
): Promise<Reservation> {
  const day = utcDay(nowSeconds);
  const micros = reserveMicrosForChat(config.priceChatInMicrosPerMTok, config.priceChatOutMicrosPerMTok);

  if (micros > config.globalDailySpendMicros) {
    throw spendCapReached();
  }

  await reserveGlobal(db, day, micros, config.globalDailySpendMicros, nowSeconds);

  const reservation: Reservation = { id: crypto.randomUUID(), userId, day, audioSeconds: 0, micros };
  const reserved = await db
    .prepare(
      `INSERT INTO usage_daily (user_id, day, audio_seconds, audio_seconds_reserved,
                                transcribe_calls, chat_calls, chat_tokens_in, chat_tokens_out, updated_at)
       VALUES (?1, ?2, 0, 0, 0, 1, 0, 0, ?3)
       ON CONFLICT(user_id, day) DO UPDATE SET
         chat_calls = usage_daily.chat_calls + 1,
         updated_at = ?3
       WHERE usage_daily.chat_calls + 1 <= ?4
       RETURNING chat_calls`,
    )
    .bind(userId, day, nowSeconds, config.userDailyChatCalls)
    .first<{ chat_calls: number }>();

  if (reserved === null) {
    await releaseGlobal(db, day, micros, nowSeconds);
    throw quotaExceeded();
  }

  await recordReservation(db, reservation, nowSeconds);
  return reservation;
}

/**
 * Records what was really used and hands back whatever was over-reserved.
 * Allowed to push the day's total past the limit: an in-flight request is
 * never killed, the next one is refused instead.
 */
export async function settle(
  db: D1Database,
  reservation: Reservation,
  actual: {
    readonly audioSeconds?: number;
    readonly micros: number;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
  },
  nowSeconds: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE usage_daily
            SET audio_seconds          = audio_seconds + ?1,
                audio_seconds_reserved = MAX(0, audio_seconds_reserved - ?2),
                chat_tokens_in         = chat_tokens_in + ?3,
                chat_tokens_out        = chat_tokens_out + ?4,
                updated_at             = ?5
          WHERE user_id = ?6 AND day = ?7`,
      )
      .bind(
        actual.audioSeconds ?? 0,
        reservation.audioSeconds,
        actual.tokensIn ?? 0,
        actual.tokensOut ?? 0,
        nowSeconds,
        reservation.userId,
        reservation.day,
      ),
    db
      .prepare(
        `UPDATE spend_daily
            SET micros_spent    = micros_spent + ?1,
                micros_reserved = MAX(0, micros_reserved - ?2),
                updated_at      = ?3
          WHERE day = ?4`,
      )
      .bind(actual.micros, reservation.micros, nowSeconds, reservation.day),
    db.prepare("DELETE FROM reservations WHERE id = ?1").bind(reservation.id),
  ]);
}

/** Settling nothing: the upstream call failed, so no money was spent. */
export function release(db: D1Database, reservation: Reservation, nowSeconds: number): Promise<void> {
  return settle(db, reservation, { audioSeconds: 0, micros: 0 }, nowSeconds);
}

async function reserveGlobal(
  db: D1Database,
  day: string,
  micros: number,
  capMicros: number,
  nowSeconds: number,
): Promise<void> {
  let row: unknown;
  try {
    row = await db
      .prepare(
        `INSERT INTO spend_daily (day, micros_spent, micros_reserved, updated_at)
         VALUES (?1, 0, ?2, ?3)
         ON CONFLICT(day) DO UPDATE SET
           micros_reserved = spend_daily.micros_reserved + ?2,
           updated_at      = ?3
         WHERE spend_daily.micros_spent + spend_daily.micros_reserved + ?2 <= ?4
         RETURNING micros_spent`,
      )
      .bind(day, micros, nowSeconds, capMicros)
      .first();
  } catch (error) {
    // A database that will not answer must not become a way to keep spending.
    console.error("[quota] global reservation failed", error);
    throw spendCapReached();
  }

  if (row === null) {
    throw spendCapReached();
  }
}

function releaseGlobal(db: D1Database, day: string, micros: number, nowSeconds: number): Promise<unknown> {
  return db
    .prepare(
      `UPDATE spend_daily
          SET micros_reserved = MAX(0, micros_reserved - ?1),
              updated_at      = ?2
        WHERE day = ?3`,
    )
    .bind(micros, nowSeconds, day)
    .run();
}

function recordReservation(db: D1Database, reservation: Reservation, nowSeconds: number): Promise<unknown> {
  // The ledger exists only so the hourly sweep can reclaim budget from an
  // isolate that died between reserve and settle.
  return db
    .prepare(
      `INSERT INTO reservations (id, user_id, day, audio_seconds, micros, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      reservation.id,
      reservation.userId,
      reservation.day,
      reservation.audioSeconds,
      reservation.micros,
      nowSeconds,
      nowSeconds + RESERVATION_TTL_SECONDS,
    )
    .run();
}

export async function readUsage(db: D1Database, userId: string, day: string): Promise<UsageRow> {
  const row = await db
    .prepare(
      `SELECT audio_seconds, audio_seconds_reserved, transcribe_calls, chat_calls
         FROM usage_daily WHERE user_id = ?1 AND day = ?2`,
    )
    .bind(userId, day)
    .first<UsageRow>();

  return row ?? { audio_seconds: 0, audio_seconds_reserved: 0, transcribe_calls: 0, chat_calls: 0 };
}

export async function isServiceAvailable(db: D1Database, day: string, capMicros: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT micros_spent, micros_reserved FROM spend_daily WHERE day = ?1")
    .bind(day)
    .first<{ micros_spent: number; micros_reserved: number }>();
  if (row === null) {
    return true;
  }
  return row.micros_spent + row.micros_reserved < capMicros;
}

function quotaExceeded() {
  return rateLimited("user-daily-quota", "You have used today's dictation allowance. It resets at midnight UTC.");
}

function spendCapReached() {
  return rateLimited("global-spend-cap", "RabbleBabble is at its daily limit. Try again tomorrow.");
}
