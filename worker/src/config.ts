/**
 * Environment parsing, done once per request and loudly.
 *
 * Every var arrives as a string. A typo in GLOBAL_DAILY_SPEND_MICROS that
 * silently became NaN would disable the spend cap while looking healthy, so
 * anything malformed throws here instead of leaking into the arithmetic.
 */

export type SignupMode = "invite" | "open" | "closed";
export type EmailMode = "resend" | "console";

export interface Config {
  readonly appOrigin: string;
  readonly signupMode: SignupMode;
  readonly emailMode: EmailMode;
  readonly emailFrom: string;
  readonly magicLinkTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly requireSameDeviceLink: boolean;
  readonly userDailyAudioSeconds: number;
  readonly userDailyTranscribeCalls: number;
  readonly userDailyChatCalls: number;
  readonly globalDailySpendMicros: number;
  readonly transcribeReserveSeconds: number;
  readonly priceTranscribeMicrosPerHour: number;
  readonly priceChatInMicrosPerMTok: number;
  readonly priceChatOutMicrosPerMTok: number;
  readonly groqBaseUrl: string;
  readonly groqApiKey: string;
  readonly resendApiKey: string;
  readonly ipHashPepper: string;
}

export class ConfigError extends Error {}

function requireString(env: Env, name: keyof Env): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Missing required configuration: ${String(name)}`);
  }
  return value.trim();
}

function requirePositiveInt(env: Env, name: keyof Env): number {
  const raw = requireString(env, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${String(name)} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function requireOneOf<T extends string>(env: Env, name: keyof Env, allowed: readonly T[]): T {
  const value = requireString(env, name);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${String(name)} must be one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value as T;
}

function requireBoolean(env: Env, name: keyof Env): boolean {
  const value = requireString(env, name);
  if (value !== "true" && value !== "false") {
    throw new ConfigError(`${String(name)} must be "true" or "false", got "${value}"`);
  }
  return value === "true";
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function readConfig(env: Env): Config {
  const appOrigin = stripTrailingSlash(requireString(env, "APP_ORIGIN"));
  // Parsed eagerly so a malformed origin fails at boot, not at the first
  // same-site check where it would silently reject every request.
  new URL(appOrigin);

  return {
    appOrigin,
    signupMode: requireOneOf(env, "SIGNUP_MODE", ["invite", "open", "closed"] as const),
    emailMode: requireOneOf(env, "EMAIL_MODE", ["resend", "console"] as const),
    emailFrom: requireString(env, "EMAIL_FROM"),
    magicLinkTtlSeconds: requirePositiveInt(env, "MAGIC_LINK_TTL_SECONDS"),
    sessionTtlSeconds: requirePositiveInt(env, "SESSION_TTL_SECONDS"),
    requireSameDeviceLink: requireBoolean(env, "REQUIRE_SAME_DEVICE_LINK"),
    userDailyAudioSeconds: requirePositiveInt(env, "USER_DAILY_AUDIO_SECONDS"),
    userDailyTranscribeCalls: requirePositiveInt(env, "USER_DAILY_TRANSCRIBE_CALLS"),
    userDailyChatCalls: requirePositiveInt(env, "USER_DAILY_CHAT_CALLS"),
    globalDailySpendMicros: requirePositiveInt(env, "GLOBAL_DAILY_SPEND_MICROS"),
    transcribeReserveSeconds: requirePositiveInt(env, "TRANSCRIBE_RESERVE_SECONDS"),
    priceTranscribeMicrosPerHour: requirePositiveInt(env, "PRICE_TRANSCRIBE_MICROS_PER_HOUR"),
    priceChatInMicrosPerMTok: requirePositiveInt(env, "PRICE_CHAT_IN_MICROS_PER_MTOK"),
    priceChatOutMicrosPerMTok: requirePositiveInt(env, "PRICE_CHAT_OUT_MICROS_PER_MTOK"),
    groqBaseUrl: stripTrailingSlash(requireString(env, "GROQ_BASE_URL")),
    groqApiKey: requireString(env, "GROQ_API_KEY"),
    // Only needed when actually sending mail; console mode runs without one.
    resendApiKey: typeof env.RESEND_API_KEY === "string" ? env.RESEND_API_KEY : "",
    ipHashPepper: requireString(env, "IP_HASH_PEPPER"),
  };
}
