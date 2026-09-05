import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_AUDIO_BYTES } from "../../src/shared/limits";
import { APP_ORIGIN, alwaysTranscribes, appHeaders, buildTestApp, createInvite, signIn, type TestApp } from "./helpers/app";

function audioBody(byteLength = 2_048): ArrayBuffer {
  return new ArrayBuffer(byteLength);
}

function postAudio(
  testApp: TestApp,
  cookie: string,
  options: { readonly body?: BodyInit; readonly contentType?: string; readonly contentLength?: string; readonly language?: string } = {},
) {
  const body = options.body ?? audioBody();
  const headers = appHeaders({
    "Content-Type": options.contentType ?? "audio/webm;codecs=opus",
    "Content-Length": options.contentLength ?? String((body as ArrayBuffer).byteLength ?? 2_048),
    Cookie: cookie,
    ...(options.language === undefined ? {} : { "X-RB-Language": options.language }),
  });
  return testApp.app.request(`${APP_ORIGIN}/v1/transcribe`, { method: "POST", headers, body });
}

async function signedIn(testApp: TestApp, address: string): Promise<string> {
  const code = await createInvite();
  return signIn(testApp, address, { inviteCode: code });
}

// Storage is isolated per test FILE, not per test, so anything asserted on
// shared tables has to be scoped to this case's own user.
async function usageFor(address: string) {
  return env.DB.prepare(
    `SELECT u.audio_seconds, u.audio_seconds_reserved
       FROM usage_daily u JOIN users s ON s.id = u.user_id
      WHERE s.email = ?1`,
  )
    .bind(address)
    .first<{ audio_seconds: number; audio_seconds_reserved: number }>();
}

async function totalSpend() {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(micros_spent), 0) AS spent, COALESCE(SUM(micros_reserved), 0) AS reserved FROM spend_daily",
  ).first<{ spent: number; reserved: number }>();
  return { spent: row?.spent ?? 0, reserved: row?.reserved ?? 0 };
}

describe("POST /v1/transcribe", () => {
  it("sends Groq a form the client cannot influence", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "shape@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("hello world", 12.5));

    const response = await postAudio(testApp, cookie, { language: "nl" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ text: "hello world", durationSeconds: 12.5 });

    const form = testApp.groqFetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    // The client cannot downgrade this to dodge duration-based metering.
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBe("nl");
  });

  it("ignores a language hint that is not a language tag", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "lang@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("ok", 10));

    await postAudio(testApp, cookie, { language: "; DROP TABLE users" });

    const form = testApp.groqFetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("language")).toBeNull();
  });

  it("refuses an oversized upload before reading the body", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "big@example.com");

    const response = await postAudio(testApp, cookie, { contentLength: String(MAX_AUDIO_BYTES + 1) });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "recording-too-large" } });
    expect(testApp.groqFetch).not.toHaveBeenCalled();
  });

  it("refuses a body larger than its declared Content-Length", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "liar@example.com");

    // A client that is not our own can declare whatever it likes.
    const response = await postAudio(testApp, cookie, {
      body: audioBody(MAX_AUDIO_BYTES + 1_024),
      contentLength: "2048",
    });

    expect(response.status).toBe(413);
    expect(testApp.groqFetch).not.toHaveBeenCalled();
  });

  it("refuses an audio type that is not on the allowlist", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "type@example.com");

    const response = await postAudio(testApp, cookie, { contentType: "application/zip" });

    expect(response.status).toBe(415);
    expect(testApp.groqFetch).not.toHaveBeenCalled();
  });

  it("never returns Groq's segment data", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "segments@example.com");
    testApp.groqFetch.mockResolvedValue(
      Response.json({ text: "hi", duration: 11, segments: [{ id: 0, start: 0, end: 11, text: "hi" }] }),
    );

    const response = await postAudio(testApp, cookie);

    await expect(response.json()).resolves.not.toHaveProperty("segments");
  });

  it("reports a rejected central key as a server error, not as an auth problem", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "badkey@example.com");
    testApp.groqFetch.mockResolvedValue(new Response("{}", { status: 401 }));

    const response = await postAudio(testApp, cookie);

    // api-unauthorized would tell the user to fix an API key setting that does
    // not exist in the hosted app. This is our configuration bug, not theirs.
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "api-server", reason: "internal" } });
  });

  it("passes an upstream rate limit through as retryable", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "busy@example.com");
    testApp.groqFetch.mockResolvedValue(new Response("{}", { status: 429, headers: { "Retry-After": "17" } }));

    const response = await postAudio(testApp, cookie);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "api-rate-limited", retryable: true, retryAfterSeconds: 17 },
    });
  });

  it("gives the budget back when Groq fails", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "refund@example.com");
    testApp.groqFetch.mockResolvedValue(new Response("{}", { status: 400 }));

    const spendBefore = await totalSpend();
    await postAudio(testApp, cookie);

    // Nothing was spent, and nothing stays reserved: a failed call must not
    // quietly eat a slice of the daily budget.
    expect(await totalSpend()).toEqual(spendBefore);
    expect(await usageFor("refund@example.com")).toMatchObject({ audio_seconds: 0, audio_seconds_reserved: 0 });
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM reservations").first<{ n: number }>();
    expect(open?.n).toBe(0);
  });

  it("charges the duration Groq reports, with the ten-second minimum", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "meter@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("brief", 3.2));

    await postAudio(testApp, cookie);

    const usage = await usageFor("meter@example.com");
    expect(usage?.audio_seconds).toBe(10);
    // The pessimistic reservation is handed back once the real cost is known.
    expect(usage?.audio_seconds_reserved).toBe(0);
  });

  it("suspends an account that submits implausibly long audio", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "abuse@example.com");
    // A 25 MB file at a very low bitrate really can be hours of speech, and
    // Groq bills for it before we ever see the duration.
    testApp.groqFetch.mockImplementation(alwaysTranscribes("...", 9 * 3_600));

    await postAudio(testApp, cookie);

    const user = await env.DB.prepare("SELECT status FROM users WHERE email = ?1")
      .bind("abuse@example.com")
      .first<{ status: string }>();
    expect(user?.status).toBe("suspended");
  });
});
