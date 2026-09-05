/**
 * Fixed-window counters in D1.
 *
 * Deliberately not the Workers rate-limiting binding: that is per-location and
 * eventually consistent, which Cloudflare documents as "not an accurate
 * accounting system". Fine as a coarse filter, useless for anything that must
 * actually hold - and these limits are what stand between a public endpoint
 * and someone burning the mail-sending reputation.
 */

export interface RateLimitRule {
  readonly bucket: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export function hourWindow(nowSeconds: number): string {
  return new Date(nowSeconds * 1000).toISOString().slice(0, 13);
}

export function dayWindow(nowSeconds: number): string {
  return new Date(nowSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Increments every bucket and reports whether all of them stayed within their
 * limit. Fails closed: a database error refuses the request.
 */
export async function consumeRateLimits(
  db: D1Database,
  rules: readonly RateLimitRule[],
  nowSeconds: number,
): Promise<RateLimitVerdict> {
  for (const rule of rules) {
    const windowStart = nowSeconds - (nowSeconds % rule.windowSeconds);
    const expiresAt = windowStart + rule.windowSeconds;

    let claimed: unknown;
    try {
      claimed = await db
        .prepare(
          `INSERT INTO auth_rate_limits (bucket, count, window_start, expires_at)
           VALUES (?1, 1, ?2, ?3)
           ON CONFLICT(bucket) DO UPDATE SET count = auth_rate_limits.count + 1
           WHERE auth_rate_limits.count < ?4
           RETURNING count`,
        )
        .bind(rule.bucket, windowStart, expiresAt, rule.limit)
        .first();
    } catch (error) {
      console.error("[ratelimit] counter failed", error);
      return { allowed: false, retryAfterSeconds: rule.windowSeconds };
    }

    if (claimed === null) {
      return { allowed: false, retryAfterSeconds: Math.max(1, expiresAt - nowSeconds) };
    }
  }

  return { allowed: true, retryAfterSeconds: 0 };
}
