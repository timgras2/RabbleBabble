/**
 * Token minting and hashing.
 *
 * Tokens are 32 bytes of CSPRNG output - 256 bits - so a single SHA-256 is the
 * right verifier. Slow KDFs exist to defend low-entropy secrets against offline
 * brute force; there is no brute force to defend against here, and a KDF on
 * every authenticated request would burn Worker CPU for nothing.
 */

const TOKEN_BYTES = 32;

export function randomToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Peppered, so stored IP hashes cannot be reversed by trying every address. */
export async function hashIp(ip: string, pepper: string): Promise<string> {
  return sha256Hex(`${pepper}:${ip}`);
}

/** Constant-time comparison for two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/** A token as it may appear in a URL: 43 base64url characters, nothing else. */
export function isWellFormedToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
