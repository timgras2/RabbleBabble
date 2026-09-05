/**
 * Hard limits shared by the browser and the Worker.
 *
 * The browser enforces these so a doomed upload never leaves a metered
 * connection; the Worker enforces them again because the client is not
 * trusted. Keeping one definition is the point: two copies of 26_214_400
 * drift, and the copy that drifts is the one that stops protecting anything.
 */

/** 25 MiB. Matches Groq's own transcription upload cap. */
export const MAX_AUDIO_BYTES = 26_214_400;

/** Five minutes. The recorder stops itself here. */
export const MAX_AUDIO_MS = 300_000;

/** Longest transcript accepted for cleanup or rewrite. */
export const MAX_TEXT_CHARS = 20_000;

/** Longest rewrite instruction accepted. */
export const MAX_INSTRUCTION_CHARS = 2_000;

/**
 * Largest JSON body the Worker will read for /v1/cleanup and /v1/rewrite.
 * MAX_TEXT_CHARS is at most ~80 KB of UTF-8, so 256 KB is comfortable.
 */
export const MAX_JSON_BODY_BYTES = 262_144;

/** Largest JSON body the Worker will read on an auth route. */
export const MAX_AUTH_BODY_BYTES = 4_096;
