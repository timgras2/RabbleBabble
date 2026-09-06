export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Carries what the provider said, never who it was for.
 *
 * `detail` is assembled from the provider's error name and message, both of
 * which describe the request rather than the recipient, so it is safe to log.
 */
export class EmailSendError extends Error {
  readonly status: number | null;
  readonly detail: string | null;

  constructor(message: string, options: { readonly status?: number; readonly detail?: string | null } = {}) {
    super(message);
    this.name = "EmailSendError";
    this.status = options.status ?? null;
    this.detail = options.detail ?? null;
  }
}

/** Pure, so the wording is unit-testable without a mail provider. */
export function magicLinkEmail(to: string, link: string, ttlMinutes: number): EmailMessage {
  const subject = "Your RabbleBabble sign-in link";
  const text = [
    "Tap the link below to sign in to RabbleBabble.",
    "",
    link,
    "",
    `The link works once and expires in ${ttlMinutes} minutes.`,
    "If you did not ask for it, you can ignore this email.",
  ].join("\n");

  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5;color:#1B2733">',
    "<p>Tap the button below to sign in to RabbleBabble.</p>",
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#E5484D;color:#fff;border-radius:8px;text-decoration:none">Sign in to RabbleBabble</a></p>`,
    `<p style="color:#5B6B7C;font-size:14px">The link works once and expires in ${ttlMinutes} minutes. If you did not ask for it, you can ignore this email.</p>`,
    "</div>",
  ].join("");

  return { to, subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
