/**
 * Cost arithmetic in USD micro-dollars, kept pure so the boundaries are
 * testable without a database or a network.
 */

/** Groq bills a 10-second minimum per transcription request. */
export const MINIMUM_BILLED_SECONDS = 10;

export function chargeableSeconds(observedSeconds: number): number {
  if (!Number.isFinite(observedSeconds) || observedSeconds <= 0) {
    return MINIMUM_BILLED_SECONDS;
  }
  return Math.max(MINIMUM_BILLED_SECONDS, Math.ceil(observedSeconds));
}

export function transcriptionMicros(seconds: number, microsPerHour: number): number {
  return Math.ceil((seconds * microsPerHour) / 3600);
}

export function chatMicros(
  promptTokens: number,
  completionTokens: number,
  inMicrosPerMTok: number,
  outMicrosPerMTok: number,
): number {
  const input = (promptTokens * inMicrosPerMTok) / 1_000_000;
  const output = (completionTokens * outMicrosPerMTok) / 1_000_000;
  return Math.ceil(input + output);
}

/**
 * What a transcription might cost at its worst, used to reserve budget before
 * the call. Deliberately pessimistic: the recorder's own hard cap, so the
 * reservation can never under-shoot what the request actually spends.
 */
export function reserveMicrosForTranscription(reserveSeconds: number, microsPerHour: number): number {
  return transcriptionMicros(reserveSeconds, microsPerHour);
}

/** A cheap fixed reservation for a chat call; settled on real token counts. */
export function reserveMicrosForChat(inMicrosPerMTok: number, outMicrosPerMTok: number): number {
  // Assumes a full-size transcript in and out: 20k chars is roughly 5k tokens.
  return chatMicros(5_000, 5_000, inMicrosPerMTok, outMicrosPerMTok);
}
