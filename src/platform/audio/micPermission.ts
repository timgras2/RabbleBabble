/**
 * Whether the microphone has been actively denied, or simply never asked for.
 *
 * The two look identical in the error the browser throws -- WebKit reports
 * `NotAllowedError` both for a real denial and for a request that arrived
 * without a live user activation -- and they need opposite advice: one is "go
 * and change a setting", the other is "just tap again".
 *
 * Feature-detected, and degrading to "unknown" rather than throwing, because
 * `navigator.permissions.query({ name: "microphone" })` is not reliably
 * supported in Safari. A UI that only shows extra help on a definite "denied"
 * is correct in all three cases.
 */
export type MicPermission = "granted" | "denied" | "prompt" | "unknown";

export async function readMicPermission(): Promise<MicPermission> {
  if (typeof navigator === "undefined" || navigator.permissions === undefined) {
    return "unknown";
  }
  try {
    // An unsupported name throws TypeError rather than resolving, which the
    // catch below is for -- Safari has never reliably supported this one.
    const status = await navigator.permissions.query({ name: "microphone" });
    return status.state;
  } catch {
    return "unknown";
  }
}
