const USAGE_RETENTION_DAYS = 90;

/**
 * Hourly housekeeping.
 *
 * Two jobs. The first is retention: expired tokens, dead sessions and stale
 * rate-limit buckets go, and usage counters are kept for 90 days - numbers
 * only, never content.
 *
 * The second is reclaiming budget. An isolate that dies between reserve and
 * settle leaves its reservation held. That fails safe (the budget looks
 * smaller than it is, so the service is over-cautious rather than
 * over-spending), but left alone it would slowly starve the daily cap. The
 * reservations ledger is what makes those recoverable.
 */
export async function runSweep(db: D1Database, nowSeconds: number): Promise<void> {
  const cutoff = new Date((nowSeconds - USAGE_RETENTION_DAYS * 86_400) * 1000).toISOString().slice(0, 10);

  await db.batch([
    db
      .prepare("DELETE FROM auth_tokens WHERE expires_at < ?1 OR (consumed_at IS NOT NULL AND consumed_at < ?2)")
      .bind(nowSeconds, nowSeconds - 86_400),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(nowSeconds),
    db.prepare("DELETE FROM auth_rate_limits WHERE expires_at < ?1").bind(nowSeconds),
    db.prepare("DELETE FROM usage_daily WHERE day < ?1").bind(cutoff),
    db.prepare("DELETE FROM spend_daily WHERE day < ?1").bind(cutoff),
  ]);

  // A live request holds a reservation for at most 120s (the transcription
  // timeout), and these expire after 600s, so nothing in flight is reclaimed.
  const { results } = await db
    .prepare("SELECT id, user_id, day, audio_seconds, micros FROM reservations WHERE expires_at < ?1")
    .bind(nowSeconds)
    .all<{ id: string; user_id: string; day: string; audio_seconds: number; micros: number }>();

  if (results.length === 0) {
    return;
  }

  console.log(`[sweep] reclaiming ${results.length} leaked reservation(s)`);

  await db.batch(
    results.flatMap((row) => [
      db
        .prepare(
          `UPDATE usage_daily
              SET audio_seconds_reserved = MAX(0, audio_seconds_reserved - ?1),
                  updated_at             = ?2
            WHERE user_id = ?3 AND day = ?4`,
        )
        .bind(row.audio_seconds, nowSeconds, row.user_id, row.day),
      db
        .prepare(
          `UPDATE spend_daily
              SET micros_reserved = MAX(0, micros_reserved - ?1),
                  updated_at      = ?2
            WHERE day = ?3`,
        )
        .bind(row.micros, nowSeconds, row.day),
      db.prepare("DELETE FROM reservations WHERE id = ?1").bind(row.id),
    ]),
  );
}
