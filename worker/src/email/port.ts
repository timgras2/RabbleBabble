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

  /**
   * A complete document, not the bare `<div>` this used to be.
   *
   * Gmail is forgiving about a fragment; Microsoft's content filter is not,
   * and an HTML part with no doctype, no `<html>` and no declared charset
   * scores against every other thing a magic-link mail already looks like -
   * one short paragraph, one big coloured call-to-action, a deadline, and a
   * long opaque token in the href.
   *
   * The href is also repeated as visible text. That is the anchor-text-matches
   * -destination signal filters look for, and it is the fallback for the
   * Outlook clients that render the button badly or strip it.
   */
  const safeLink = escapeHtml(link);
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${subject}</title>`,
    "</head>",
    '<body style="margin:0;padding:24px;background:#ffffff">',
    // Shown as the inbox snippet instead of the first line of body copy.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">Your sign-in link, good for ${ttlMinutes} minutes.</div>`,
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5;color:#1B2733">',
    "<p>Tap the button below to sign in to RabbleBabble.</p>",
    `<p><a href="${safeLink}" style="display:inline-block;padding:12px 20px;background:#E5484D;color:#fff;border-radius:8px;text-decoration:none">Sign in to RabbleBabble</a></p>`,
    '<p style="color:#5B6B7C;font-size:14px">Or paste this address into your browser:</p>',
    `<p style="word-break:break-all;font-size:14px"><a href="${safeLink}" style="color:#5B6B7C">${safeLink}</a></p>`,
    `<p style="color:#5B6B7C;font-size:14px">The link works once and expires in ${ttlMinutes} minutes. If you did not ask for it, you can ignore this email.</p>`,
    "</div>",
    "</body>",
    "</html>",
  ].join("");

  return { to, subject, text, html };
}

/**
 * Strips addresses out of provider copy before it reaches a log line.
 *
 * Resend's message for an unverified domain quotes an address back at you, a
 * validation error on the `to` field could quote the recipient, and a bounce
 * webhook carries the remote MTA's diagnostic, which almost always names the
 * mailbox it rejected. The rest of each of those is the part worth reading, so
 * the addresses are removed rather than the whole message being thrown away.
 */
export function redactAddresses(value: string): string {
  return value.replace(/[^\s<>()"',;:]+@[^\s<>()"',;:]+/g, "[address]");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
