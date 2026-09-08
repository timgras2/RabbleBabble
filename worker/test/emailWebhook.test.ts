import { describe, expect, it, vi } from "vitest";
import { APP_ORIGIN, buildTestApp, type TestApp } from "./helpers/app";
import { parseEmailEvent, severityOf } from "../src/email/webhook";

const SECRET = "whsec_dGVzdC13ZWJob29rLXNlY3JldC1ub3QtcmVhbA==";
const ENDPOINT = `${APP_ORIGIN}/auth/email-events`;
const RECIPIENT = "someone@outlook.com";

function bouncePayload(detail: string): string {
  return JSON.stringify({
    type: "email.bounced",
    created_at: "2026-09-08T08:00:00.000Z",
    data: {
      email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
      from: "RabbleBabble <login@send.rabblebabble.cc>",
      to: [RECIPIENT],
      subject: "Your RabbleBabble sign-in link",
      bounce: { type: "Permanent", subType: "Suppressed", message: detail },
    },
  });
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** The signing half of the scheme the route verifies. */
async function sign(id: string, timestamp: number, body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    decode(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  let binary = "";
  for (const byte of new Uint8Array(mac)) {
    binary += String.fromCharCode(byte);
  }
  return `v1,${btoa(binary)}`;
}

function configured(): TestApp {
  return buildTestApp({ emailMode: "resend", resendWebhookSecret: SECRET });
}

async function post(
  testApp: TestApp,
  body: string,
  options: { readonly skew?: number; readonly signature?: string; readonly prefix?: "svix" | "webhook" } = {},
): Promise<Response> {
  const id = "msg_2abc";
  const timestamp = testApp.clock.nowSeconds() + (options.skew ?? 0);
  const prefix = options.prefix ?? "svix";
  return testApp.app.request(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [`${prefix}-id`]: id,
      [`${prefix}-timestamp`]: String(timestamp),
      [`${prefix}-signature`]: options.signature ?? (await sign(id, timestamp, body)),
    },
    body,
  });
}

/** The one `email-event` line, or undefined. */
function loggedEvent(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> | undefined {
  for (const call of spy.mock.calls) {
    const line = String(call[0]);
    if (line.includes('"event":"email-event"')) {
      return JSON.parse(line) as Record<string, unknown>;
    }
  }
  return undefined;
}

describe("POST /auth/email-events", () => {
  it("does not exist at all when no signing secret is configured", async () => {
    // Fail closed. An endpoint that is present but unauthenticated would be a
    // free log-injection surface on a route prefix that skips both auth guards.
    const response = await post(buildTestApp({ emailMode: "resend", resendWebhookSecret: "" }), bouncePayload("x"));

    expect(response.status).toBe(404);
  });

  it("refuses a body with no signature headers", async () => {
    const response = await configured().app.request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bouncePayload("x"),
    });

    expect(response.status).toBe(401);
  });

  it("refuses a signature that does not match the body", async () => {
    const testApp = configured();
    const body = bouncePayload("x");
    const signature = await sign("msg_2abc", testApp.clock.nowSeconds(), "a different body");

    expect((await post(testApp, body, { signature })).status).toBe(401);
  });

  it("refuses a correctly signed replay from outside the tolerance window", async () => {
    expect((await post(configured(), bouncePayload("x"), { skew: -3_600 })).status).toBe(401);
  });

  it("accepts the vendor-neutral header names as well as Svix's own", async () => {
    expect((await post(configured(), bouncePayload("x"), { prefix: "webhook" })).status).toBe(204);
  });

  it("accepts a body signed with any one of several keys, so a rotation does not drop events", async () => {
    const testApp = configured();
    const body = bouncePayload("x");
    const stale = await sign("msg_2abc", testApp.clock.nowSeconds(), body, "whsec_b3RoZXItc2VjcmV0LWVudGlyZWx5");
    const live = await sign("msg_2abc", testApp.clock.nowSeconds(), body);

    expect((await post(testApp, body, { signature: `${stale} ${live}` })).status).toBe(204);
  });

  it("logs a bounce by hash, never by address", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const testApp = configured();

    const response = await post(testApp, bouncePayload("smtp; 550 5.7.1 message rejected"));

    expect(response.status).toBe(204);
    const line = loggedEvent(errors);
    expect(line).toMatchObject({
      type: "email.bounced",
      providerMessageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
      bounceType: "Permanent",
      bounceSubType: "Suppressed",
    });
    // The whole point of the hash: an operator can join this to the sign-in
    // attempt that caused it without either line carrying who it was for.
    expect(String(line?.recipientHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(line)).not.toContain(RECIPIENT);
  });

  it("strips the address the remote MTA quotes back in its diagnostic", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const testApp = configured();

    await post(testApp, bouncePayload(`smtp; 550 5.4.1 Recipient address rejected: ${RECIPIENT}`));

    const line = loggedEvent(errors);
    expect(String(line?.detail)).toContain("550 5.4.1 Recipient address rejected");
    expect(String(line?.detail)).toContain("[address]");
    expect(String(line?.detail)).not.toContain(RECIPIENT);
  });

  it("acknowledges an event it has no use for without logging it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const testApp = configured();

    // Open tracking is off, and would be a bad idea: it works by rewriting
    // links and embedding a pixel, which costs the very deliverability this
    // endpoint exists to measure. A 4xx here would make Resend retry forever.
    const response = await post(testApp, JSON.stringify({ type: "email.opened", data: { email_id: "x" } }));

    expect(response.status).toBe(204);
    expect(loggedEvent(errors)).toBeUndefined();
    expect(loggedEvent(logs)).toBeUndefined();
  });

  it("refuses a body far larger than any real event", async () => {
    const testApp = configured();
    const body = JSON.stringify({ type: "email.bounced", data: { subject: "z".repeat(40_000) } });

    expect((await post(testApp, body)).status).toBe(413);
  });
});

describe("parseEmailEvent", () => {
  it("reads a bounce", () => {
    const event = parseEmailEvent(JSON.parse(bouncePayload("smtp; 550")));

    expect(event).toEqual({
      type: "email.bounced",
      emailId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
      recipient: RECIPIENT,
      bounceType: "Permanent",
      bounceSubType: "Suppressed",
      detail: "smtp; 550",
    });
  });

  it("reads a failure, which carries its reason somewhere else entirely", () => {
    const event = parseEmailEvent({ type: "email.failed", data: { failed: { reason: "no recipients" } } });

    expect(event?.detail).toBe("no recipients");
    expect(event?.bounceType).toBeNull();
  });

  it("returns null for a body that is not an event", () => {
    expect(parseEmailEvent(null)).toBeNull();
    expect(parseEmailEvent({ data: {} })).toBeNull();
  });
});

describe("severityOf", () => {
  it("treats the three bad outcomes as errors and the rest as information", () => {
    expect(severityOf("email.bounced")).toBe("error");
    expect(severityOf("email.complained")).toBe("error");
    expect(severityOf("email.failed")).toBe("error");
    expect(severityOf("email.delivered")).toBe("info");
    expect(severityOf("email.delivery_delayed")).toBe("info");
    // Never enabled, and never logged if they arrive anyway.
    expect(severityOf("email.opened")).toBeNull();
    expect(severityOf("email.clicked")).toBeNull();
  });
});
