/**
 * Which browser family the user is in, only where the recovery instructions
 * genuinely differ.
 *
 * Kept in one place on purpose: the alternative is `navigator.userAgent`
 * scattered through the UI, and this is the only question the UI needs to ask.
 */
export type BrowserFamily = "ios-safari" | "other";

export function browserFamily(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): BrowserFamily {
  // Every browser on iOS is WebKit, and every one of them sends the user to
  // the same two settings screens, so the engine is the right thing to detect.
  const isIosLike = /iPad|iPhone|iPod/.test(userAgent) ||
    // iPadOS reports itself as a Mac; a touch-capable "Mac" is an iPad.
    (/Macintosh/.test(userAgent) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
  return isIosLike ? "ios-safari" : "other";
}
