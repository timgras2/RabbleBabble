import type { EmailMessage, EmailSender } from "./port";

/**
 * The development mailer. Nothing leaves the process.
 *
 * This is what lets the whole auth flow - interstitial, device binding,
 * single-use consumption - be exercised before a sending domain is verified.
 * The recipient address in the log line is acceptable precisely because this
 * adapter never runs in production; do not copy the pattern into resend.ts.
 */
export class ConsoleEmailSender implements EmailSender {
  send(message: EmailMessage): Promise<void> {
    const found = message.text.split("\n").find((line) => line.startsWith("http"));
    console.log(`[email:console] to=${message.to} subject=${message.subject} link=${found ?? "(none)"}`);
    return Promise.resolve();
  }
}
