import { EmailSendError, type EmailMessage, type EmailSender } from "./port";
import { defaultFetch } from "../http/fetcher";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;
const MAX_DETAIL_CHARS = 200;

/**
 * Resend will only deliver to addresses other than the account owner's once a
 * sending domain is verified (SPF + DKIM). Until then this throws and the
 * request still returns 202 - see the no-enumeration note in auth/routes.
 *
 * That swallowing is why this adapter works so hard on its own logging: a
 * failure here has no other symptom than mail that never arrives.
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetcher: typeof fetch = defaultFetch(),
  ) {}

  async send(message: EmailMessage): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // A timeout or a DNS failure produces no status at all. Wrapping it here
      // means the caller's log line has one shape rather than two.
      throw new EmailSendError("Resend could not be reached", { detail: errorName(error) });
    }

    if (!response.ok) {
      // The body can name the recipient, so it is summarised rather than kept.
      throw new EmailSendError(`Resend rejected the message with status ${response.status}`, {
        status: response.status,
        detail: await readProviderError(response),
      });
    }

    // The message id is the only handle on a sent mail: without it, "did it
    // actually go out?" can only be answered by searching Resend's dashboard
    // for the recipient - which means having the address to hand, which is
    // exactly what must not be in these logs.
    console.log(
      JSON.stringify({
        event: "email-sent",
        provider: "resend",
        providerMessageId: await readMessageId(response),
      }),
    );
  }
}

/** Resend answers `{"name":"validation_error","message":"..."}`. */
async function readProviderError(response: Response): Promise<string | null> {
  const record = await readJson(response);
  const name = typeof record.name === "string" ? record.name : "unknown_error";
  const message = typeof record.message === "string" ? redactAddresses(record.message) : "";
  return (message === "" ? name : `${name}: ${message}`).slice(0, MAX_DETAIL_CHARS);
}

async function readMessageId(response: Response): Promise<string | null> {
  const record = await readJson(response);
  return typeof record.id === "string" ? record.id : null;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await response.json();
    return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  } catch {
    // A proxy's HTML error page, or an empty body. Not worth failing over.
    return {};
  }
}

/**
 * Resend's copy for an unverified domain quotes an address back at you, and a
 * validation error on the `to` field could quote the recipient. The rest of
 * the message is the part worth reading, so the addresses are removed rather
 * than the whole message being thrown away.
 */
function redactAddresses(value: string): string {
  return value.replace(/[^\s<>()"',;:]+@[^\s<>()"',;:]+/g, "[address]");
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "unknown";
}
