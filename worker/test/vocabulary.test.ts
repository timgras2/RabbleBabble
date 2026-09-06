import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_VOCABULARY_CHARS } from "../../src/shared/limits";
import {
  APP_ORIGIN,
  alwaysTranscribes,
  appHeaders,
  buildTestApp,
  createInvite,
  jsonHeaders,
  signIn,
  type TestApp,
} from "./helpers/app";

async function signedIn(testApp: TestApp, address: string): Promise<string> {
  return signIn(testApp, address, { inviteCode: await createInvite() });
}

function patchMe(testApp: TestApp, cookie: string, body: unknown) {
  return testApp.app.request(`${APP_ORIGIN}/v1/me`, {
    method: "PATCH",
    headers: jsonHeaders({ Cookie: cookie }),
    body: JSON.stringify(body),
  });
}

describe("personal vocabulary", () => {
  it("round-trips through PATCH and GET /v1/me", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "vocab@example.com");

    await expect(patchMe(testApp, cookie, { vocabulary: "  Aisling, Kubernetes  " })).resolves.toMatchObject({
      status: 200,
    });

    const me = await testApp.app.request(`${APP_ORIGIN}/v1/me`, { headers: appHeaders({ Cookie: cookie }) });
    await expect(me.json()).resolves.toMatchObject({ user: { vocabulary: "Aisling, Kubernetes" } });
  });

  it("refuses a vocabulary longer than the shared cap", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "toolong@example.com");

    const response = await patchMe(testApp, cookie, { vocabulary: "x".repeat(MAX_VOCABULARY_CHARS + 1) });

    expect(response.status).toBe(413);
  });

  /**
   * The client sends raw audio bytes and the Worker builds the Groq form, so
   * this has to come from the session row. A vocabulary the caller could set
   * per-request would be exactly the influence over that form the whole design
   * refuses to allow.
   */
  it("sends the saved vocabulary to Groq as the transcription prompt", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "prompted@example.com");
    await patchMe(testApp, cookie, { vocabulary: "RabbleBabble, EBITDA" });
    testApp.groqFetch.mockImplementation(alwaysTranscribes("hello", 4));

    await testApp.app.request(`${APP_ORIGIN}/v1/transcribe`, {
      method: "POST",
      headers: appHeaders({ "Content-Type": "audio/webm", "Content-Length": "2048", Cookie: cookie }),
      body: new ArrayBuffer(2_048),
    });

    const form = testApp.groqFetch.mock.calls[0]![1]?.body as FormData;
    expect(form.get("prompt")).toBe("RabbleBabble, EBITDA");
  });

  it("sends no prompt at all when nothing is saved", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "noprompt@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("hello", 4));

    await testApp.app.request(`${APP_ORIGIN}/v1/transcribe`, {
      method: "POST",
      headers: appHeaders({ "Content-Type": "audio/webm", "Content-Length": "2048", Cookie: cookie }),
      body: new ArrayBuffer(2_048),
    });

    const form = testApp.groqFetch.mock.calls[0]![1]?.body as FormData;
    expect(form.get("prompt")).toBeNull();
  });

  it("erases the vocabulary along with the account", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "erased@example.com");
    await patchMe(testApp, cookie, { vocabulary: "secret jargon" });

    await testApp.app.request(`${APP_ORIGIN}/v1/me`, { method: "DELETE", headers: appHeaders({ Cookie: cookie }) });

    const row = await env.DB.prepare("SELECT vocabulary FROM users WHERE email = ?1")
      .bind("erased@example.com")
      .first();
    expect(row).toBeNull();
  });
});
