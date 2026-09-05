import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runSweep } from "../src/db/sweep";

const NOW = 1_800_000_000;
// Must be a day the retention window still keeps, or the sweep deletes the
// counters before it ever reaches the reclaim step.
const DAY = new Date(NOW * 1000).toISOString().slice(0, 10);

describe("runSweep", () => {
  it("reclaims budget from a reservation whose request never finished", async () => {
    await env.DB.prepare(
      "INSERT INTO spend_daily (day, micros_spent, micros_reserved, updated_at) VALUES (?1, 0, 5000, ?2)",
    )
      .bind(DAY, NOW)
      .run();
    await env.DB.prepare(
      "INSERT INTO users (id, email, status, created_at) VALUES ('u1', 'leak@example.com', 'active', ?1)",
    )
      .bind(NOW)
      .run();
    await env.DB.prepare(
      `INSERT INTO usage_daily (user_id, day, audio_seconds, audio_seconds_reserved,
                                transcribe_calls, chat_calls, chat_tokens_in, chat_tokens_out, updated_at)
       VALUES ('u1', ?1, 0, 300, 1, 0, 0, 0, ?2)`,
    )
      .bind(DAY, NOW)
      .run();
    await env.DB.prepare(
      `INSERT INTO reservations (id, user_id, day, audio_seconds, micros, created_at, expires_at)
       VALUES ('r1', 'u1', ?1, 300, 5000, ?2, ?3)`,
    )
      .bind(DAY, NOW - 700, NOW - 100)
      .run();

    await runSweep(env.DB, NOW);

    const spend = await env.DB.prepare("SELECT micros_reserved FROM spend_daily WHERE day = ?1")
      .bind(DAY)
      .first<{ micros_reserved: number }>();
    const usage = await env.DB.prepare("SELECT audio_seconds_reserved FROM usage_daily WHERE user_id = 'u1'")
      .first<{ audio_seconds_reserved: number }>();
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM reservations").first<{ n: number }>();

    // Budget an isolate died holding comes back, rather than slowly starving
    // the daily cap.
    expect(spend?.micros_reserved).toBe(0);
    expect(usage?.audio_seconds_reserved).toBe(0);
    expect(left?.n).toBe(0);
  });

  it("leaves a reservation that could still belong to a live request", async () => {
    await env.DB.prepare(
      `INSERT INTO reservations (id, user_id, day, audio_seconds, micros, created_at, expires_at)
       VALUES ('r2', 'u2', ?1, 300, 5000, ?2, ?3)`,
    )
      .bind(DAY, NOW, NOW + 500)
      .run();

    await runSweep(env.DB, NOW);

    // The longest legitimate request is a 120s transcription and these expire
    // after 600s, so nothing in flight is ever reclaimed underneath it.
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM reservations WHERE id = 'r2'").first<{ n: number }>();
    expect(left?.n).toBe(1);
  });

  it("drops expired sessions and spent sign-in tokens", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, status, created_at) VALUES ('u3', 'old@example.com', 'active', ?1)",
    )
      .bind(NOW)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_hash, user_id, created_at, expires_at, last_seen_at)
       VALUES ('dead', 'u3', ?1, ?2, ?1)`,
    )
      .bind(NOW - 1_000, NOW - 10)
      .run();
    await env.DB.prepare(
      `INSERT INTO auth_tokens (token_hash, user_id, created_at, expires_at, consumed_at)
       VALUES ('spent', 'u3', ?1, ?2, ?3)`,
    )
      .bind(NOW - 200_000, NOW - 190_000, NOW - 180_000)
      .run();

    await runSweep(env.DB, NOW);

    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    const tokens = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_tokens").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    expect(tokens?.n).toBe(0);
  });
});
