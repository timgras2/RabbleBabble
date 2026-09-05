import { env } from "cloudflare:test";
import { vi } from "vitest";
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from "../../../src/shared/wire";
import { createApp, type App } from "../../src/app";
import { readConfig, type Config } from "../../src/config";
import type { Deps } from "../../src/deps";
import type { EmailMessage, EmailSender } from "../../src/email/port";
import { GroqGateway } from "../../src/groq/gateway";
import type { Clock } from "../../src/usage/clock";

export const APP_ORIGIN = "http://localhost:8787";

/** Records what would have been sent, and hands back the link for the test. */
export class RecordingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  shouldFail = false;

  send(message: EmailMessage): Promise<void> {
    if (this.shouldFail) {
      return Promise.reject(new Error("mail provider is down"));
    }
    this.sent.push(message);
    return Promise.resolve();
  }

  lastLinkSent(): string | undefined {
    const last = this.sent.at(-1);
    return last?.text.split("\n").find((line) => line.startsWith("http"));
  }
}

const BASE_EPOCH = 1_760_000_000;
let dayOffset = 0;

export class TestClock implements Clock {
  constructor(private current = BASE_EPOCH) {}
  nowSeconds(): number {
    return this.current;
  }
  advance(seconds: number): void {
    this.current += seconds;
  }
}

export interface TestApp {
  readonly app: App;
  readonly email: RecordingEmailSender;
  readonly clock: TestClock;
  readonly groqFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly config: Config;
}

export function buildTestApp(overrides: Partial<Config> = {}): TestApp {
  const email = new RecordingEmailSender();
  // Storage is isolated per test FILE, so every app gets its own UTC day.
  // Otherwise the global spend_daily row accumulates across cases and a cap
  // test fails because an earlier case already spent the budget.
  dayOffset += 1;
  const clock = new TestClock(BASE_EPOCH + dayOffset * 86_400);
  const groqFetch = vi.fn<typeof fetch>();
  // appOrigin is pinned rather than inherited: it is a deployment detail,
  // and letting it leak in here means pointing wrangler.jsonc at a real URL
  // breaks every same-site assertion in the suite.
  const config: Config = { ...readConfig(env), appOrigin: APP_ORIGIN, ...overrides };

  const deps: Deps = {
    config,
    db: env.DB,
    clock,
    email,
    groq: new GroqGateway({ baseUrl: config.groqBaseUrl, apiKey: config.groqApiKey, fetcher: groqFetch }),
  };

  return { app: createApp(deps), email, clock, groqFetch, config };
}

let nextClientIp = 0;

/** A distinct caller each time, so per-IP limits do not bleed between cases. */
export function uniqueIp(): string {
  nextClientIp += 1;
  return `203.0.113.${nextClientIp % 254}`;
}

/** Headers a genuine request from the PWA carries. */
export function appHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Origin: APP_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "CF-Connecting-IP": uniqueIp(),
    [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
    ...extra,
  };
}

export function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return appHeaders({ "Content-Type": "application/json", ...extra });
}

/** Pulls one cookie's value out of a response's Set-Cookie headers. */
export function cookieFrom(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const separator = pair?.indexOf("=") ?? -1;
    if (pair !== undefined && separator !== -1 && pair.slice(0, separator).trim() === name) {
      const value = pair.slice(separator + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/** Signs a fresh user in and returns the session cookie header value. */
export async function signIn(
  testApp: TestApp,
  address: string,
  options: { readonly inviteCode?: string } = {},
): Promise<string> {
  const requested = await testApp.app.request(`${APP_ORIGIN}/auth/request-link`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email: address, ...(options.inviteCode ? { inviteCode: options.inviteCode } : {}) }),
  });
  if (requested.status !== 202) {
    throw new Error(`request-link returned ${requested.status}`);
  }

  const nonce = cookieFrom(requested, "__Host-rb_link");
  const link = testApp.email.lastLinkSent();
  if (link === undefined) {
    throw new Error("no sign-in link was sent");
  }
  const token = new URL(link).searchParams.get("token") ?? "";

  const consumed = await testApp.app.request(`${APP_ORIGIN}/auth/callback`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      ...(nonce === null ? {} : { Cookie: `__Host-rb_link=${nonce}` }),
    },
    body: new URLSearchParams({ token }).toString(),
  });
  if (consumed.status !== 303) {
    throw new Error(`callback returned ${consumed.status}`);
  }

  const session = cookieFrom(consumed, "__Host-rb_session");
  if (session === null) {
    throw new Error("no session cookie was set");
  }
  return `__Host-rb_session=${session}`;
}

export async function createInvite(maxUses = 1): Promise<string> {
  const { generateInviteCode, hashInviteCode } = await import("../../src/auth/invites");
  const code = generateInviteCode();
  await env.DB.prepare(
    `INSERT INTO invite_codes (code_hash, label, max_uses, uses, expires_at, created_at, disabled_at)
     VALUES (?1, 'test', ?2, 0, NULL, ?3, NULL)`,
  )
    .bind(await hashInviteCode(code), maxUses, 1_760_000_000)
    .run();
  return code;
}

export function groqTranscription(text: string, duration: number): Response {
  return Response.json({ text, duration, language: "en", segments: [] });
}

/** A fresh Response per call. A Response body can only be read once. */
export function alwaysTranscribes(text: string, duration: number): typeof fetch {
  return (async () => groqTranscription(text, duration)) as unknown as typeof fetch;
}

export function alwaysChats(text: string, promptTokens = 100, completionTokens = 100): typeof fetch {
  return (async () => groqChat(text, promptTokens, completionTokens)) as unknown as typeof fetch;
}

export function groqChat(text: string, promptTokens = 100, completionTokens = 100): Response {
  return Response.json({
    choices: [{ message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  });
}
