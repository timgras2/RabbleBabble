import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from "../../../src/shared/wire";
import { originRejected } from "../errors";

/**
 * CSRF defence, in layers, with no token table.
 *
 * SameSite=Lax already stops the session cookie riding along on a cross-site
 * POST. These two guards cover what Lax does not: POST /auth/callback accepts
 * form-encoded bodies, which is a CORS-"simple" content type a cross-site form
 * can send, and no other origin is CORS-allowlisted so a custom header cannot
 * be set cross-origin without a preflight that will fail.
 */

export function requireSameSite(request: Request, appOrigin: string): void {
  // Sec-Fetch-Site is the strongest signal where it exists. "none" is a
  // typed-in URL or a link from outside a page, which is how a magic link
  // legitimately arrives.
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw originRejected();
  }

  const origin = request.headers.get("Origin");
  if (origin === null) {
    return;
  }
  // A referrer policy of no-referrer makes the browser serialise Origin as
  // the literal string "null" - which is what a form post from our own
  // interstitial used to send. Sec-Fetch-Site has already vouched for this
  // being same-origin above, so trusting it here costs nothing and stops a
  // future header quirk locking everyone out of sign-in.
  if (origin === "null" && fetchSite === "same-origin") {
    return;
  }
  if (origin !== appOrigin) {
    throw originRejected();
  }
}

/**
 * Required on everything the app itself calls with fetch. Deliberately NOT
 * required on POST /auth/callback, which is a plain HTML form submission from
 * the interstitial and cannot set custom headers.
 */
export function requireClientHeader(request: Request): void {
  if (request.headers.get(CLIENT_HEADER) !== CLIENT_HEADER_VALUE) {
    throw originRejected();
  }
}
