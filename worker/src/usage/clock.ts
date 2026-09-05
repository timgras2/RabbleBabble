/** Injected so quota and expiry tests do not depend on the wall clock. */
export interface Clock {
  nowSeconds(): number;
}

export const systemClock: Clock = {
  nowSeconds: () => Math.floor(Date.now() / 1000),
};

/** UTC day key, "YYYY-MM-DD". Quotas reset at UTC midnight. */
export function utcDay(nowSeconds: number): string {
  return new Date(nowSeconds * 1000).toISOString().slice(0, 10);
}

/** Epoch seconds of the next UTC midnight, for "resets at" in the UI. */
export function nextUtcMidnight(nowSeconds: number): number {
  const date = new Date(nowSeconds * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) / 1000);
}
