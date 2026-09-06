import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, readConfig } from "../src/config";
import { EmailSendError, magicLinkEmail } from "../src/email/port";
import { ResendEmailSender } from "../src/email/resend";

const FROM = "RabbleBabble <login@send.rabblebabble.cc>";
const RECIPIENT = "someone@example.com";
const LINK = "https://rabblebabble.cc/auth/callback?token=abc123";

type Fetcher = ReturnType<typeof vi.fn<typeof fetch>>;

function sender(respond: () => Response): { fetcher: Fetcher; mailer: ResendEmailSender } {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(respond()));
  return { fetcher, mailer: new ResendEmailSender("re_test_key", FROM, fetcher) };
}

function requestOf(fetcher: Fetcher): {
  url: unknown;
  init: RequestInit;
  headers: Headers;
  body: Record<string, unknown>;
} {
  const call = fetcher.mock.calls[0];
  if (call === undefined) {
    throw new Error("the mailer never called its fetcher");
  }
  const [url, init] = call;
  if (init === undefined) {
    throw new Error("the mailer called fetch without an init");
  }
  return {
    url,
    init,
    headers: new Headers(init.headers),
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
}

describe("ResendEmailSender", () => {
  it("posts the message to Resend's send endpoint", async () => {
    const { fetcher, mailer } = sender(() => Response.json({ id: "3f7a" }));

    await mailer.send(magicLinkEmail(RECIPIENT, LINK, 15));

    const { url, init, headers, body } = requestOf(fetcher);
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(headers.get("Authorization")).toBe("Bearer re_test_key");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(body.from).toBe(FROM);
    // Resend takes a list even for a single recipient; a bare string is a 422.
    expect(body.to).toEqual([RECIPIENT]);
    expect(String(body.text)).toContain(LINK);
    expect(String(body.html)).toContain(LINK);
  });

  it("logs the provider's message id, the only handle on a sent mail", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { mailer } = sender(() => Response.json({ id: "3f7a-9c1e" }));

    await mailer.send(magicLinkEmail(RECIPIENT, LINK, 15));

    const line = String(logged.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(line)).toMatchObject({ event: "email-sent", providerMessageId: "3f7a-9c1e" });
    // Whatever else that line carries, it must never carry who it went to.
    expect(line).not.toContain(RECIPIENT);
  });

  it("summarises a rejection without repeating the recipient or the raw body", async () => {
    const { mailer } = sender(() =>
      Response.json(
        {
          name: "validation_error",
          message: `You can only send testing emails to your own address. To reach ${RECIPIENT}, verify a domain.`,
        },
        { status: 422 },
      ),
    );

    const thrown: unknown = await mailer.send(magicLinkEmail(RECIPIENT, LINK, 15)).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(EmailSendError);
    const failure = thrown as EmailSendError;
    expect(failure.status).toBe(422);
    // The name is an enum and the message explains the fix. Both are what turn
    // a silently swallowed send into something an operator can act on.
    expect(failure.detail).toContain("validation_error");
    expect(failure.detail).toContain("verify a domain");
    expect(`${failure.message} ${String(failure.detail)}`).not.toContain(RECIPIENT);
  });

  it("survives an error body that is not JSON at all", async () => {
    const { mailer } = sender(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    const thrown: unknown = await mailer.send(magicLinkEmail(RECIPIENT, LINK, 15)).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(EmailSendError);
    expect((thrown as EmailSendError).status).toBe(502);
    expect((thrown as EmailSendError).detail).toBe("unknown_error");
  });

  it("reports a provider that cannot be reached at all", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const mailer = new ResendEmailSender("re_test_key", FROM, fetcher);

    const thrown: unknown = await mailer.send(magicLinkEmail(RECIPIENT, LINK, 15)).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(EmailSendError);
    // No status at all, which is the whole reason a transport failure is
    // wrapped rather than left to reach the caller in its own shape.
    expect((thrown as EmailSendError).status).toBeNull();
    expect((thrown as EmailSendError).detail).toBe("TimeoutError");
  });

  it("gives up on Resend after ten seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { fetcher, mailer } = sender(() => Response.json({ id: "x" }));

    await mailer.send(magicLinkEmail(RECIPIENT, LINK, 15));

    // Asserted through the constructor rather than by waiting: a hung provider
    // must not hold a sign-in request open for the Worker's whole budget.
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(requestOf(fetcher).init.signal?.aborted).toBe(false);
  });
});

describe("magicLinkEmail", () => {
  it("puts the link bare on a line of its own", () => {
    const message = magicLinkEmail(RECIPIENT, LINK, 15);

    // ConsoleEmailSender and the test harness both find the link with
    // `line.startsWith("http")`. Indent it or wrap it in <> and every auth
    // test fails three files away with "no sign-in link was sent".
    expect(message.text.split("\n").filter((line) => line.startsWith("http"))).toEqual([LINK]);
  });

  it("escapes the link before putting it in an href", () => {
    const hostile = `${LINK}&next="><script>`;

    const message = magicLinkEmail(RECIPIENT, hostile, 15);

    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&amp;next=&quot;&gt;&lt;script&gt;");
  });

  it("says how long the link lasts", () => {
    const message = magicLinkEmail(RECIPIENT, LINK, 15);

    expect(message.subject).toBe("Your RabbleBabble sign-in link");
    expect(message.text).toContain("expires in 15 minutes");
    expect(message.to).toBe(RECIPIENT);
  });
});

describe("readConfig, email settings", () => {
  // wrangler types gives the vars literal types, so an override needs the cast.
  const withEnv = (overrides: Record<string, string>): Env => ({ ...env, ...overrides }) as unknown as Env;
  const resend = (overrides: Record<string, string> = {}): Env =>
    withEnv({
      EMAIL_MODE: "resend",
      EMAIL_FROM: FROM,
      RESEND_API_KEY: "re_test_key",
      ...overrides,
    });

  it("refuses to boot in resend mode without a key", () => {
    expect(() => readConfig(resend({ RESEND_API_KEY: "" }))).toThrow(ConfigError);
    expect(() => readConfig(resend({ RESEND_API_KEY: "   " }))).toThrow(/RESEND_API_KEY/);
  });

  it("refuses the placeholder From, which can never hold SPF or DKIM", () => {
    expect(() => readConfig(resend({ EMAIL_FROM: "RabbleBabble <login@example.invalid>" }))).toThrow(/placeholder/);
  });

  it("refuses a From that is not a sendable address", () => {
    expect(() => readConfig(resend({ EMAIL_FROM: "RabbleBabble" }))).toThrow(ConfigError);
    expect(() => readConfig(resend({ EMAIL_FROM: "login@localhost" }))).toThrow(ConfigError);
  });

  it("accepts both a bare address and a display name", () => {
    expect(readConfig(resend({ EMAIL_FROM: "login@send.rabblebabble.cc" })).emailFrom).toBe(
      "login@send.rabblebabble.cc",
    );
    expect(readConfig(resend()).emailFrom).toBe(FROM);
    expect(readConfig(resend()).resendApiKey).toBe("re_test_key");
  });

  it("keeps the placeholder usable in console mode, which never dials out", () => {
    const config = readConfig(
      withEnv({ EMAIL_MODE: "console", EMAIL_FROM: "RabbleBabble <login@example.invalid>", RESEND_API_KEY: "" }),
    );

    expect(config.emailMode).toBe("console");
    expect(config.resendApiKey).toBe("");
  });
});
