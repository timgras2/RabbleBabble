/**
 * The page a magic link actually lands on.
 *
 * The link is NOT redeemed by the GET that opens it. Gmail, Outlook/Defender
 * and corporate mail gateways all fetch links found in email to scan them; a
 * single-use token consumed on GET is burned before the recipient ever taps
 * it, which is the most common way magic links break in production. Scanners
 * do not submit forms, so redemption happens on the POST from this page.
 *
 * It also removes login-CSRF-by-prefetch: nothing changes until a human acts.
 */

const STYLES = [
  "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f6f2;",
  "font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1B2733}",
  "main{text-align:center;padding:24px;max-width:22rem}",
  "h1{font-size:1.25rem;margin:0 0 .5rem}",
  "p{color:#5B6B7C;font-size:.95rem;line-height:1.5;margin:0 0 1.5rem}",
  "button{font:inherit;font-weight:600;color:#fff;background:#E5484D;border:0;border-radius:10px;",
  "padding:14px 22px;width:100%;cursor:pointer}",
  "@media(prefers-color-scheme:dark){body{background:#14181d;color:#eef2f6}p{color:#9aa8b6}}",
].join("");

export function interstitialHtml(token: string): string {
  // The token is validated against a strict base64url pattern before reaching
  // here, so there is nothing in it that could escape the attribute.
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex">',
    "<title>Sign in to RabbleBabble</title>",
    `<style>${STYLES}</style>`,
    "</head><body><main>",
    "<h1>Sign in to RabbleBabble</h1>",
    "<p>Tap below to finish signing in on this device.</p>",
    '<form method="POST" action="/auth/callback">',
    `<input type="hidden" name="token" value="${token}">`,
    '<button type="submit">Continue</button>',
    "</form>",
    "</main></body></html>",
  ].join("");
}

export function interstitialResponse(token: string): Response {
  return new Response(interstitialHtml(token), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    },
  });
}
