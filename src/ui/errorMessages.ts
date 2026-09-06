import { SERVICE_MODE } from "../app/mode";
import type { AdapterError } from "../platform/errors";
import { browserFamily } from "./platform";

export interface ErrorMessage {
  readonly title: string;
  readonly detail: string;
}

/**
 * Shared by the recorder, the sign-in screen and settings.
 *
 * Several entries are mode-dependent, and not cosmetically: a hosted user has
 * no API key and no Settings field to fix, so telling them to check one would
 * send them somewhere that does not exist. They should never see the word
 * "Groq" at all - as far as they are concerned, the service is RabbleBabble.
 */
export function messageForError(error: AdapterError): ErrorMessage {
  switch (error.code) {
    case "missing-api-key":
      return SERVICE_MODE
        ? { title: "You are not signed in", detail: "Sign in to start dictating." }
        : { title: "Add your Groq API key", detail: "Open Settings to enter it before recording." };
    case "not-authenticated":
      return { title: "Your session ended", detail: "Sign in again to keep dictating." };
    case "not-invited":
      return { title: "That invite code did not work", detail: "Check the code from your invite and try again." };
    case "quota-exceeded":
      return {
        title: "Daily limit reached",
        detail: "Your allowance resets after midnight UTC.",
      };
    // iOS never re-prompts once denied, and there is no programmatic way to
    // ask again, so naming Chrome sent iPhone users to a screen that does not
    // exist -- indistinguishable from the microphone being blocked by default.
    case "mic-denied":
      return browserFamily() === "ios-safari"
        ? {
            title: "Microphone permission is off",
            detail: "Tap aA in the address bar, choose Website Settings, and allow Microphone. Or Settings > Safari > Microphone.",
          }
        : {
            title: "Microphone permission is off",
            detail: "Allow microphone access for this site in your browser, then try again.",
          };
    case "mic-unavailable":
      return browserFamily() === "ios-safari"
        ? {
            title: "No microphone available",
            detail: "Check the device microphone, and that Safari is allowed to use it in Settings > Safari > Microphone.",
          }
        : {
            title: "No microphone available",
            detail: "Check the device microphone and the browser's site permissions.",
          };
    case "offline":
      return { title: "You are offline", detail: "Reconnect to the internet. Recordings are not queued." };
    case "api-unauthorized":
      return SERVICE_MODE
        ? { title: "That request was rejected", detail: "Sign in again, then try once more." }
        : { title: "The API key was rejected", detail: "Replace it with a valid Groq key in Settings." };
    case "api-rate-limited":
      return {
        title: SERVICE_MODE ? "Too many requests" : "Groq rate limit reached",
        detail: "Wait a moment and try again.",
      };
    case "recording-too-long":
      return { title: "Recording is too long", detail: "Keep recordings under five minutes." };
    case "recording-too-large":
      return { title: "Recording is too large", detail: "Keep recordings under 25 MB." };
    case "recording-invalid":
      return { title: "That recording could not be read", detail: "Try recording again." };
    case "api-timeout":
      return { title: "The request timed out", detail: "Check your connection and try again." };
    case "invalid-instruction":
      return { title: "Add a rewrite instruction", detail: "Describe how you want the transcript changed." };
    case "rewrite-too-large":
      return {
        title: "Rewrite request is too long",
        detail: "Shorten the transcript or rewrite instruction and try again.",
      };
    case "cancelled":
      return { title: "Request cancelled", detail: "No changes were made to the transcript." };
    // These three used to fall through to the raw adapter message, which is
    // written for a developer reading a stack trace, not for someone holding
    // a phone. errorMessages.test.ts now refuses to let a code slip through.
    case "empty-transcript":
      return { title: "Nothing was picked up", detail: "No speech was detected. Try recording again." };
    case "clipboard-unavailable":
      return {
        title: "Copying is unavailable here",
        detail: "This browser will not let the page use the clipboard. Select the text and copy it by hand.",
      };
    case "clipboard-denied":
      return {
        title: "Clipboard permission is off",
        detail: "Allow clipboard access for this site, then tap Copy again.",
      };
    case "api-server":
      return { title: SERVICE_MODE ? "Could not reach RabbleBabble" : "Could not reach Groq", detail: safeNetworkDetail(error) };
    case "api-invalid":
      return {
        title: SERVICE_MODE ? "RabbleBabble rejected the request" : "Groq rejected the request",
        detail: "Check the recording format and try again.",
      };
    default:
      return { title: "Request failed", detail: error.message };
  }
}

export function safeNetworkDetail(error: AdapterError): string {
  const cause = error.cause;
  if (cause instanceof Error && cause.message && cause.message.length < 120) {
    return `${cause.message}. Check the HTTPS connection and the Network tab for a blocked request.`;
  }
  return "The browser could not complete the request. Check the HTTPS connection and the Network tab for a blocked request.";
}
