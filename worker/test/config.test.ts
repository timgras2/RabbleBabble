import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "../src/config";

function withEnv(overrides: Record<string, string>): Env {
  return { ...env, ...overrides } as Env;
}

describe("readConfig", () => {
  /**
   * Console mode returns the complete working magic link in the response body
   * to anyone who POSTs a valid address, and logs it with the recipient. The
   * code documented the danger honestly and nothing enforced it -- while
   * `npm run dev:worker` forces the mode with a --var, so the muscle memory
   * to type it exists.
   */
  it("refuses EMAIL_MODE=console anywhere but a loopback origin", () => {
    expect(() =>
      readConfig(withEnv({ EMAIL_MODE: "console", APP_ORIGIN: "https://rabblebabble.cc" })),
    ).toThrowError(ConfigError);
  });

  it("allows EMAIL_MODE=console on localhost, which is what dev:worker uses", () => {
    expect(() => readConfig(withEnv({ EMAIL_MODE: "console", APP_ORIGIN: "http://localhost:8787" }))).not.toThrow();
  });

  /** The only way to stop the service used to be setting the cap to 1. */
  it("accepts a zero global spend cap as the kill switch", () => {
    expect(readConfig(withEnv({ GLOBAL_DAILY_SPEND_MICROS: "0" })).globalDailySpendMicros).toBe(0);
  });

  it("still refuses a negative or malformed spend cap", () => {
    expect(() => readConfig(withEnv({ GLOBAL_DAILY_SPEND_MICROS: "-1" }))).toThrowError(ConfigError);
    expect(() => readConfig(withEnv({ GLOBAL_DAILY_SPEND_MICROS: "lots" }))).toThrowError(ConfigError);
  });
});
