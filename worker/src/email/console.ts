import type { EmailMessage, EmailSender } from "./port";

/**
 * Prints the sign-in link instead of sending it.
 *
 * This is what lets the whole auth flow - interstitial, device binding,
 * single-use consumption - be exercised before a sending domain is verified.
 */
export class ConsoleEmailSender implements EmailSender {
  private link: string | undefined;

  send(message: EmailMessage): Promise<void> {
    const found = message.text.split("\n").find((line) => line.startsWith("http"));
    this.link = found;
    console.log(`[email:console] to=${message.to} subject=${message.subject} link=${found ?? "(none)"}`);
    return Promise.resolve();
  }

  readonly lastLink = (): string | undefined => this.link;
}
