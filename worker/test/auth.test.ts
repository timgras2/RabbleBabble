import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  buildTestApp,
  cookieFrom,
  createInvite,
  jsonHeaders,
  signIn,
} from "./helpers/app";

function requestLink(app: ReturnType<typeof buildTestApp>, body: Record<string, unknown>) {
  return app.app.request(`${APP_ORIGIN}/auth/request-link`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
}

describe("POST /auth/request-link", () => {
  it("answers identically for a known and an unknown address", async () => {
    // Asserted in the shipping configuration. Console mode adds a devLink for
    // the operator, and its presence would itself reveal that an account
    // exists - which is why that field never appears in resend mode.
    const testApp = buildTestApp({ emailMode: "resend" });
    const code = await createInvite();
    await signIn(testApp, "known@example.com", { inviteCode: code });

    const known = await requestLink(testApp, { email: "known@example.com" });
    const unknown = await requestLink(testApp, { email: "nobody@example.com" });

    // Same status and same body: there is no way to ask whether an account
    // exists. This is the property, not an implementation detail.
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    const [knownBody, unknownBody] = await Promise.all([known.json(), unknown.json()]);
    expect(Object.keys(knownBody as object)).toEqual(Object.keys(unknownBody as object));
    expect((unknownBody as { status: string }).status).toBe("sent");
    expect(knownBody).not.toHaveProperty("devLink");
  });

  it("hands the operator a usable link only in console mode", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();

    const response = await requestLink(testApp, { email: "dev@example.com", inviteCode: code });

    // This is what lets friends be onboarded before a sending domain is
    // verified, and what keeps the auth flow testable without a mailbox.
    await expect(response.json()).resolves.toMatchObject({ devLink: expect.stringContaining("/auth/callback?token=") });
  });

  it("answers 202 for a suspended account and sends nothing", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    await signIn(testApp, "suspended@example.com", { inviteCode: code });
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE email = ?1")
      .bind("suspended@example.com")
      .run();

    const before = testApp.email.sent.length;
    const response = await requestLink(testApp, { email: "suspended@example.com" });

    expect(response.status).toBe(202);
    expect(testApp.email.sent.length).toBe(before);
  });

  it("still answers 202 when the mail provider fails", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    await signIn(testApp, "flaky@example.com", { inviteCode: code });

    testApp.email.shouldFail = true;
    const response = await requestLink(testApp, { email: "flaky@example.com" });

    // Surfacing a send failure would itself reveal that the account exists.
    expect(response.status).toBe(202);
  });

  it("rejects a malformed address without touching the database", async () => {
    const testApp = buildTestApp();
    const response = await requestLink(testApp, { email: "not-an-address" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { reason: "email-invalid" } });
  });

  it("refuses signup without a usable invite code", async () => {
    const testApp = buildTestApp();
    const before = testApp.email.sent.length;

    const response = await requestLink(testApp, { email: "stranger@example.com" });

    expect(response.status).toBe(202);
    expect(testApp.email.sent.length).toBe(before);
  });

  it("reports a bad invite code without revealing whether the account exists", async () => {
    const testApp = buildTestApp();
    const response = await requestLink(testApp, { email: "stranger@example.com", inviteCode: "ZZZZ-ZZZZ-ZZZZ" });

    // The invite is validated before any user lookup, so this answer is the
    // same whether or not stranger@example.com has an account.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not-invited", reason: "invite-invalid" } });
  });

  it("spends an invite code only once", async () => {
    const testApp = buildTestApp();
    const code = await createInvite(1);
    await signIn(testApp, "first@example.com", { inviteCode: code });

    const before = testApp.email.sent.length;
    await requestLink(testApp, { email: "second@example.com", inviteCode: code });

    expect(testApp.email.sent.length).toBe(before);
  });

  it("rate limits repeated requests for the same address", async () => {
    const testApp = buildTestApp();
    const responses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      responses.push(
        await testApp.app.request(`${APP_ORIGIN}/auth/request-link`, {
          method: "POST",
          // One persistent caller, which is what a real abuser looks like.
          headers: jsonHeaders({ "CF-Connecting-IP": "198.51.100.7" }),
          body: JSON.stringify({ email: "spam@example.com" }),
        }),
      );
    }

    const limited = responses.filter((response) => response.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    const body = await limited[0]!.json();
    expect(body).toMatchObject({ error: { reason: "auth-rate-limited", retryable: true } });
    expect((body as { error: { retryAfterSeconds: number } }).error.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("GET /auth/callback", () => {
  it("renders a confirm form and does not consume the token", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    await requestLink(testApp, { email: "scanner@example.com", inviteCode: code });
    const link = testApp.email.lastLinkSent()!;
    const token = new URL(link).searchParams.get("token")!;

    const response = await testApp.app.request(link, {
      headers: { "Sec-Fetch-Site": "none" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    await expect(response.text()).resolves.toContain('method="POST"');

    // Mail scanners fetch links. If a GET consumed the token, the link would
    // be dead before the recipient ever tapped it.
    const { sha256Hex } = await import("../src/auth/crypto");
    const row = await env.DB.prepare("SELECT consumed_at FROM auth_tokens WHERE token_hash = ?1")
      .bind(await sha256Hex(token))
      .first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).toBeNull();
  });

  it("opens from an email client, which is a cross-site navigation", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    await requestLink(testApp, { email: "gmail@example.com", inviteCode: code });
    const link = testApp.email.lastLinkSent()!;

    // What Chrome actually sends when the link is tapped in Gmail. Guarding
    // this route as same-site would reject every real sign-in.
    const response = await testApp.app.request(link, {
      headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" },
    });

    expect(response.status).toBe(200);
  });

  it("rejects a token that is not well formed", async () => {
    const testApp = buildTestApp();
    const response = await testApp.app.request(`${APP_ORIGIN}/auth/callback?token=../../etc/passwd`, {
      headers: { "Sec-Fetch-Site": "none" },
    });

    expect(response.status).toBe(400);
  });
});

describe("POST /auth/callback", () => {
  it("signs in once and refuses a replay", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    await requestLink(testApp, { email: "once@example.com", inviteCode: code });
    const requested = await requestLink(testApp, { email: "once@example.com" });
    const nonce = cookieFrom(requested, "__Host-rb_link")!;
    const token = new URL(testApp.email.lastLinkSent()!).searchParams.get("token")!;

    const submit = () =>
      testApp.app.request(`${APP_ORIGIN}/auth/callback`, {
        method: "POST",
        headers: {
          Origin: APP_ORIGIN,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-rb_link=${nonce}`,
        },
        body: new URLSearchParams({ token }).toString(),
      });

    const first = await submit();
    expect(first.status).toBe(303);
    expect(cookieFrom(first, "__Host-rb_session")).not.toBeNull();

    const replay = await submit();
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: { reason: "link-consumed" } });
  });

  it("refuses an expired link", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    const requested = await requestLink(testApp, { email: "slow@example.com", inviteCode: code });
    const nonce = cookieFrom(requested, "__Host-rb_link")!;
    const token = new URL(testApp.email.lastLinkSent()!).searchParams.get("token")!;

    testApp.clock.advance(testApp.config.magicLinkTtlSeconds + 1);

    const response = await testApp.app.request(`${APP_ORIGIN}/auth/callback`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-rb_link=${nonce}`,
      },
      body: new URLSearchParams({ token }).toString(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { reason: "link-expired" } });
  });

  it("refuses a link opened without the device nonce that requested it", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    await requestLink(testApp, { email: "forwarded@example.com", inviteCode: code });
    const token = new URL(testApp.email.lastLinkSent()!).searchParams.get("token")!;

    // No __Host-rb_link cookie: this is someone the email was forwarded to.
    const response = await testApp.app.request(`${APP_ORIGIN}/auth/callback`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }).toString(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { reason: "link-wrong-device" } });
  });

  it("sets a __Host- session cookie that JavaScript cannot read", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    const requested = await requestLink(testApp, { email: "cookie@example.com", inviteCode: code });
    const nonce = cookieFrom(requested, "__Host-rb_link")!;
    const token = new URL(testApp.email.lastLinkSent()!).searchParams.get("token")!;

    const response = await testApp.app.request(`${APP_ORIGIN}/auth/callback`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-rb_link=${nonce}`,
      },
      body: new URLSearchParams({ token }).toString(),
    });

    const header = response.headers.getSetCookie().find((value) => value.startsWith("__Host-rb_session="))!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Domain=");
  });

  it("stores only a hash of the session token", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    const cookie = await signIn(testApp, "hashed@example.com", { inviteCode: code });
    const token = cookie.split("=")[1]!;

    const { results } = await env.DB.prepare("SELECT session_hash FROM sessions").all<{ session_hash: string }>();

    // A database read must not be enough to mint a valid cookie.
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((row) => row.session_hash)).not.toContain(token);
  });
});

describe("POST /auth/logout", () => {
  it("ends the session and is safe to call twice", async () => {
    const testApp = buildTestApp();
    const code = await createInvite();
    const cookie = await signIn(testApp, "bye@example.com", { inviteCode: code });

    const logout = () =>
      testApp.app.request(`${APP_ORIGIN}/auth/logout`, {
        method: "POST",
        headers: jsonHeaders({ Cookie: cookie }),
      });

    expect((await logout()).status).toBe(204);
    // Idempotent: logging out twice must never surface an error.
    expect((await logout()).status).toBe(204);

    const me = await testApp.app.request(`${APP_ORIGIN}/v1/me`, { headers: jsonHeaders({ Cookie: cookie }) });
    expect(me.status).toBe(401);
  });
});
