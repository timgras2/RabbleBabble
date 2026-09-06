import { EmailSendError, type EmailMessage, type EmailSender } from "./port";
import { defaultFetch } from "../http/fetcher";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

/**
 * Resend will only deliver to addresses other than the account owner's once a
 * sending domain is verified (SPF + DKIM). Until then this throws and the
 * request still returns 202 - see the no-enumeration note in auth/routes.
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetcher: typeof fetch = defaultFetch(),
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await this.fetcher(RESEND_ENDPOINT, {
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

    if (!response.ok) {
      // The body can name the recipient, so it is summarised rather than kept.
      throw new EmailSendError(`Resend rejected the message with status ${response.status}`);
    }
  }
}
