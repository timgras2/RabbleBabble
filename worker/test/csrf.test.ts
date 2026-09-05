import { describe, expect, it } from "vitest";
import { APP_ORIGIN, buildTestApp, createInvite, jsonHeaders, signIn } from "./helpers/app";

/**
 * The session cookie is SameSite=Lax, which already blocks it on a cross-site
 * POST. These cases cover what Lax does not: a form-encoded POST is a
 * CORS-"simple" request a cross-site form can actually send.
 */
describe("cross-site protection", () => {
  it("rejects a request without the client header", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    const cookie = await signIn(testApp, "guard1@example.com", { inviteCode: code });

    const response = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
      headers: { Origin: APP_ORIGIN, "Sec-Fetch-Site": "same-origin", Cookie: cookie },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { reason: "origin-rejected" } });
  });

  it("rejects a request from another origin", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    const cookie = await signIn(testApp, "guard2@example.com", { inviteCode: code });

    const response = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
      headers: jsonHeaders({ Origin: "https://evil.example", Cookie: cookie }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects a cross-site fetch even with the right origin header missing", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    const cookie = await signIn(testApp, "guard3@example.com", { inviteCode: code });

    const response = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
      headers: jsonHeaders({ "Sec-Fetch-Site": "cross-site", Cookie: cookie }),
    });

    expect(response.status).toBe(403);
  });

  it("accepts the interstitial form post, which cannot set a custom header", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();

    // signIn drives exactly that path: a form-encoded POST with no
    // X-RB-Client header. If the guard applied there, nobody could sign in.
    await expect(signIn(testApp, "form@example.com", { inviteCode: code })).resolves.toContain("__Host-rb_session=");
  });

  it("accepts the null Origin a no-referrer form post produces", async () => {
    const testApp = buildTestApp();

    // Chrome serialises Origin as the literal "null" when the page that
    // submits the form has a no-referrer policy. Sec-Fetch-Site still says
    // same-origin, and rejecting this locked every real sign-in out.
    const response = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
      headers: jsonHeaders({ Origin: "null", "Sec-Fetch-Site": "same-origin" }),
    });

    expect(response.status).toBe(401);
  });

  it("still rejects a null Origin that claims to be cross-site", async () => {
    const testApp = buildTestApp();
    const response = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
      headers: jsonHeaders({ Origin: "null", "Sec-Fetch-Site": "cross-site" }),
    });

    expect(response.status).toBe(403);
  });

  it("serves the interstitial with a referrer policy its own form can use", async () => {
    const testApp = buildTestApp();
    const code2 = await createInvite();
    await testApp.app.request(`${APP_ORIGIN}/auth/request-link`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "policy@example.com", inviteCode: code2 }),
    });
    const link = testApp.email.lastLinkSent()!;

    const response = await testApp.app.request(link, { headers: { "Sec-Fetch-Site": "cross-site" } });

    // no-referrer here would make the browser send "Origin: null" on the
    // form post and break sign-in outright.
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("answers an unauthenticated request with the shared error envelope", async () => {
    const testApp = buildTestApp();

    const response = await testApp.app.request(`${APP_ORIGIN}/v1/me`, { headers: jsonHeaders() });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not-authenticated", reason: "not-authenticated", retryable: false },
    });
  });

  it("never lets a response be cached", async () => {
    const testApp = buildTestApp();
    const response = await testApp.app.request(`${APP_ORIGIN}/v1/me`, { headers: jsonHeaders() });

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });
});
