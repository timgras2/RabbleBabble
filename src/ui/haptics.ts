/**
 * Dictation happens while walking or not looking at the screen, so start and
 * stop need confirmation you can feel. Unsupported everywhere except Android
 * Chrome, which is the target -- absence is fine, so every call is a no-op if
 * the API is missing or the platform refuses.
 */
function vibrate(pattern: number | readonly number[]): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
    return;
  }
  try {
    navigator.vibrate(pattern as number | number[]);
  } catch {
    // Vibration is a nicety; never let it surface as an error.
  }
}

export const haptics = {
  recordStart: () => vibrate(18),
  recordStop: () => vibrate([12, 40, 12]),
  copied: () => vibrate(10),
};
