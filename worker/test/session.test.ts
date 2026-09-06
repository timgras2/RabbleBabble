import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { APP_ORIGIN, appHeaders, buildTestApp, createInvite, jsonHeaders, signIn, type TestApp } from "./helpers/app";

async function signedIn(testApp: TestApp, address: string): Promise<string> {
  return signIn(testApp, address, { inviteCode: await createInvite() });
}

function sessionRows(email: string) {
  return env.DB.prepare(
    "SELECT s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?1",
  )
    .bind(email)
    .all<{ expires_at: number }>();
}

describe("sessions", () => {
  it("slides the expiry forward on the once-a-day touch", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "sliding@example.com");
    const before = (await sessionRows("sliding@example.com")).results[0]!.expires_at;

    // Past the 24h threshold touchSession waits for, so it actually writes.
    testApp.clock.advance(2 * 86_400);
    await testApp.app.request(`${APP_ORIGIN}/v1/me`, { headers: appHeaders({ Cookie: cookie }) });

    const after = (await sessionRows("sliding@example.com")).results[0]!.expires_at;
    // A daily user is never signed out; an abandoned phone still stops being
    // a key 90 days after it was last used.
    expect(after).toBe(testApp.clock.nowSeconds() + testApp.config.sessionTtlSeconds);
    expect(after).toBeGreaterThan(before);
  });

  it("replaces outstanding sessions when a new link is redeemed", async () => {
    const testApp = buildTestApp();
    const first = await signedIn(testApp, "rotating@example.com");
    await signIn(testApp, "rotating@example.com");

    // Rotation at sign-in, not per request: per-request rotation races two
    // concurrent requests into dropping a session that is perfectly good.
    expect((await sessionRows("rotating@example.com")).results).toHaveLength(1);
    const replayed = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
      headers: appHeaders({ Cookie: first }),
    });
    expect(replayed.status).toBe(401);
  });

  /**
   * revokeAllSessions existed and was unreachable: the client posted no body
   * at all, and the server read the flag as the string "true", so a JSON
   * boolean did nothing. Two independent no-ops stacked on each other.
   */
  it("signs out everywhere when the client asks it to", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "everywhere@example.com");
    await env.DB.prepare(
      "INSERT INTO sessions (session_hash, user_id, created_at, expires_at, last_seen_at) SELECT 'other-device', id, 1, 9999999999, 1 FROM users WHERE email = ?1",
    )
      .bind("everywhere@example.com")
      .run();
    expect((await sessionRows("everywhere@example.com")).results).toHaveLength(2);

    await testApp.app.request(`${APP_ORIGIN}/auth/logout`, {
      method: "POST",
      headers: jsonHeaders({ Cookie: cookie }),
      body: JSON.stringify({ allDevices: true }),
    });

    expect((await sessionRows("everywhere@example.com")).results).toHaveLength(0);
  });

  it("leaves other devices alone on an ordinary sign out", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "onedevice@example.com");
    await env.DB.prepare(
      "INSERT INTO sessions (session_hash, user_id, created_at, expires_at, last_seen_at) SELECT 'still-here', id, 1, 9999999999, 1 FROM users WHERE email = ?1",
    )
      .bind("onedevice@example.com")
      .run();

    await testApp.app.request(`${APP_ORIGIN}/auth/logout`, {
      method: "POST",
      headers: jsonHeaders({ Cookie: cookie }),
      body: JSON.stringify({ allDevices: false }),
    });

    expect((await sessionRows("onedevice@example.com")).results).toHaveLength(1);
  });
});

describe("DELETE /v1/me", () => {
  it("erases the account and everything that cascades from it", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "gone@example.com");

    const response = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
      method: "DELETE",
      headers: appHeaders({ Cookie: cookie }),
    });

    expect(response.status).toBe(204);
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind("gone@example.com").first();
    expect(user).toBeNull();
    // ON DELETE CASCADE was already declared; only the entry point was missing.
    expect((await sessionRows("gone@example.com")).results).toHaveLength(0);
  });
});
