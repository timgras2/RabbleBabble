import { EmailSendError, redactAddresses, type EmailMessage, type EmailSender } from "./port";
import { defaultFetch } from "../http/fetcher";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const ATTEMPT_TIMEOUT_MS = 10_000;
/**
 * The send runs inside `waitUntil`, not inside the response, so it can take
 * longer than a request - but not unboundedly. Retries stop once another
 * attempt could not finish inside this budget.
 */
const TOTAL_BUDGET_MS = 25_000;
/** One retry that beats a blip, one that beats a rate-limit window. */
const BACKOFF_MS = [500, 2_000] as const;
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const MAX_BACKOFF_MS = 5_000;
const MAX_DETAIL_CHARS = 200;

export type Sleeper = (milliseconds: number) => Promise<void>;

function realSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Resend will only deliver to addresses other than the account owner's once a
 * sending domain is verified (SPF + DKIM). Until then this throws and the
 * request still returns 202 - see the no-enumeration note in auth/routes.
 *
 * That swallowing is why this adapter works so hard on its own logging: a
 * failure here has no other symptom than mail that never arrives.
 *
 * It is also why transient failures are retried rather than merely reported.
 * A 429 - Resend's default is two requests a second, which a burst of sign-ins
 * clears easily - or a 502 used to lose the sign-in link outright: the caller
 * swallows the error by design, the user is told to check their email, and
 * nothing ever arrives. A single dropped request is indistinguishable from a
 * spam filter at the far end, which is exactly what made "delivery is
 * unreliable for some people" so hard to pin on anything.
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetcher: typeof fetch = defaultFetch(),
    private readonly sleep: Sleeper = realSleep,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    // Stable across retries, so a response we never saw cannot become a second
    // sign-in link in the recipient's inbox. Resend honours it for 24 hours.
    const idempotencyKey = crypto.randomUUID();
    const startedAt = Date.now();
    let failure = new EmailSendError("Resend was never called");

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const outcome = await this.attempt(message, idempotencyKey);

      if (outcome.ok) {
        // The message id is the only handle on a sent mail: without it, "did it
        // actually go out?" can only be answered by searching Resend's dashboard
        // for the recipient - which means having the address to hand, which is
        // exactly what must not be in these logs.
        console.log(
          JSON.stringify({
            event: "email-sent",
            provider: "resend",
            providerMessageId: outcome.messageId,
            attempts: attempt + 1,
          }),
        );
        return;
      }

      failure = outcome.error;
      const backoff = outcome.retryable ? nextBackoff(attempt, outcome.retryAfterMs) : null;
      if (backoff === null || Date.now() - startedAt + backoff + ATTEMPT_TIMEOUT_MS > TOTAL_BUDGET_MS) {
        break;
      }

      console.log(
        JSON.stringify({
          event: "email-send-retry",
          provider: "resend",
          attempt: attempt + 1,
          providerStatus: failure.status,
          detail: failure.detail,
          backoffMs: backoff,
        }),
      );
      await this.sleep(backoff);
    }

    throw failure;
  }

  private async attempt(message: EmailMessage, idempotencyKey: string): Promise<Attempt> {
    let response: Response;
    try {
      response = await this.fetcher(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
    } catch (error) {
      // A timeout or a DNS failure produces no status at all. Wrapping it here
      // means the caller's log line has one shape rather than two.
      return {
        ok: false,
        retryable: true,
        retryAfterMs: null,
        error: new EmailSendError("Resend could not be reached", { detail: errorName(error) }),
      };
    }

    if (!response.ok) {
      // The body can name the recipient, so it is summarised rather than kept.
      return {
        ok: false,
        // A 422 is a bad From or a bad address, and a 401 a bad key: retrying
        // either just burns the budget. Everything transient is 429 or 5xx.
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs: readRetryAfterMs(response),
        error: new EmailSendError(`Resend rejected the message with status ${response.status}`, {
          status: response.status,
          detail: await readProviderError(response),
        }),
      };
    }

    return { ok: true, messageId: await readMessageId(response) };
  }
}

type Attempt =
  | { readonly ok: true; readonly messageId: string | null }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly retryAfterMs: number | null;
      readonly error: EmailSendError;
    };

/** `null` means stop: the schedule is exhausted. */
function nextBackoff(attempt: number, retryAfterMs: number | null): number | null {
  const scheduled = BACKOFF_MS[attempt];
  if (scheduled === undefined) {
    return null;
  }
  // Resend's own advice wins when it gives any, but it does not get to hold
  // the isolate open for a minute.
  return Math.min(Math.max(scheduled, retryAfterMs ?? 0), MAX_BACKOFF_MS);
}

/** Seconds, per RFC 9110. Resend sends it on 429; the date form is ignored. */
function readRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  if (header === null) {
    return null;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
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

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "unknown";
}
