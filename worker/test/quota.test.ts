import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  appHeaders,
  buildTestApp,
  createInvite,
  alwaysTranscribes,
  signIn,
  type TestApp,
} from "./helpers/app";

function postAudio(testApp: TestApp, cookie: string) {
  const body = new ArrayBuffer(2_048);
  return testApp.app.request(`${APP_ORIGIN}/v1/transcribe`, {
    method: "POST",
    headers: appHeaders({
      "Content-Type": "audio/webm",
      "Content-Length": "2048",
      Cookie: cookie,
    }),
    body,
  });
}

async function signedIn(testApp: TestApp, address: string): Promise<string> {
  const code = await createInvite();
  return signIn(testApp, address, { inviteCode: code });
}

describe("per-user quota", () => {
  it("refuses the next request once the daily allowance is gone", async () => {
    // One transcription's pessimistic reservation is 300s, so a 600s
    // allowance is exactly two calls.
    const testApp = buildTestApp({ userDailyAudioSeconds: 600, transcribeReserveSeconds: 300 });
    const cookie = await signedIn(testApp, "capped@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("words", 300));

    expect((await postAudio(testApp, cookie)).status).toBe(200);
    expect((await postAudio(testApp, cookie)).status).toBe(200);

    const refused = await postAudio(testApp, cookie);
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "quota-exceeded", reason: "user-daily-quota", retryable: true },
    });
  });

  /**
   * SQLite never evaluates an ON CONFLICT ... WHERE guard on the INSERT path.
   * Without an explicit check in application code, the very first request of a
   * day would sail past a limit it already exceeds by itself.
   */
  it("refuses an over-limit request on the first call of the day", async () => {
    const testApp = buildTestApp({ userDailyAudioSeconds: 60, transcribeReserveSeconds: 300 });
    const cookie = await signedIn(testApp, "firstcall@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("words", 30));

    const response = await postAudio(testApp, cookie);

    expect(response.status).toBe(429);
    expect(testApp.groqFetch).not.toHaveBeenCalled();
  });

  it("counts chat calls separately from audio", async () => {
    const testApp = buildTestApp({ userDailyChatCalls: 1 });
    const cookie = await signedIn(testApp, "chatcap@example.com");
    testApp.groqFetch.mockImplementation(async () => Response.json({ choices: [{ message: { content: "tidy" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
    );

    const cleanup = () =>
      testApp.app.request(`${APP_ORIGIN}/v1/cleanup`, {
        method: "POST",
        headers: appHeaders({ "Content-Type": "application/json", Cookie: cookie }),
        body: JSON.stringify({ text: "some words" }),
      });

    expect((await cleanup()).status).toBe(200);
    expect((await cleanup()).status).toBe(429);
  });
});

describe("global spend cap", () => {
  it("fails closed once the daily budget is committed", async () => {
    // A cap smaller than a single reservation: nothing may get through.
    const testApp = buildTestApp({ globalDailySpendMicros: 10 });
    const cookie = await signedIn(testApp, "capped-global@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("words", 30));

    const response = await postAudio(testApp, cookie);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "quota-exceeded", reason: "global-spend-cap" },
    });
    // The point of failing closed: no money was spent finding out.
    expect(testApp.groqFetch).not.toHaveBeenCalled();
  });

  it("tells the client the service is unavailable rather than letting it try", async () => {
    const testApp = buildTestApp({ globalDailySpendMicros: 1_000 });
    const cookie = await signedIn(testApp, "status@example.com");

    const day = new Date(testApp.clock.nowSeconds() * 1000).toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO spend_daily (day, micros_spent, micros_reserved, updated_at) VALUES (?1, 5000, 0, ?2)",
    )
      .bind(day, testApp.clock.nowSeconds())
      .run();

    const me = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
      headers: appHeaders({ Cookie: cookie }),
    });

    await expect(me.json()).resolves.toMatchObject({
      service: { available: false, reason: "global-spend-cap" },
    });
  });

  it("lets exactly one of two simultaneous requests through at the boundary", async () => {
    // Budget for one reservation and no more.
    const testApp = buildTestApp({ transcribeReserveSeconds: 300 });
    const oneReservation = Math.ceil((300 * testApp.config.priceTranscribeMicrosPerHour) / 3600);
    const bounded = buildTestApp({ transcribeReserveSeconds: 300, globalDailySpendMicros: oneReservation });
    const cookie = await signedIn(bounded, "race@example.com");
    bounded.groqFetch.mockImplementation(alwaysTranscribes("words", 30));

    const [first, second] = await Promise.all([postAudio(bounded, cookie), postAudio(bounded, cookie)]);
    const statuses = [first.status, second.status].sort();

    // The compare-and-increment is what makes this deterministic; a
    // read-then-write would let both through.
    expect(statuses).toEqual([200, 429]);
  });
});

describe("GET /v1/me", () => {
  it("reports usage and the limits the server actually enforces", async () => {
    const testApp = buildTestApp({ userDailyAudioSeconds: 10_800 });
    const cookie = await signedIn(testApp, "me@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("words", 42));
    await postAudio(testApp, cookie);

    const response = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
      headers: appHeaders({ Cookie: cookie }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { email: string };
      quota: { audioSecondsUsed: number; audioSecondsLimit: number; resetsAtEpochSeconds: number };
      limits: { maxAudioBytes: number };
    };
    expect(body.user.email).toBe("me@example.com");
    expect(body.quota.audioSecondsUsed).toBe(42);
    expect(body.quota.audioSecondsLimit).toBe(10_800);
    // Returned so the client renders the truth rather than a compiled-in guess.
    expect(body.limits.maxAudioBytes).toBe(26_214_400);
    expect(body.quota.resetsAtEpochSeconds).toBeGreaterThan(testApp.clock.nowSeconds());
  });
});
