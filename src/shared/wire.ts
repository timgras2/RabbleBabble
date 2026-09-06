/**
 * The HTTP contract between the PWA and the Worker, defined once.
 *
 * Types only - no runtime values - so this file is free to import into either
 * side without dragging anything along.
 */
import type { AdapterErrorCode, BackendErrorReason } from "./errorCodes";

/** Every non-2xx response from the Worker has exactly this shape. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: AdapterErrorCode;
    readonly reason: BackendErrorReason;
    /** Safe to show a user. Never contains transcript or audio content. */
    readonly message: string;
    readonly retryable: boolean;
    readonly retryAfterSeconds?: number;
    readonly requestId: string;
  };
}

export interface QuotaBody {
  /** UTC day, "YYYY-MM-DD". */
  readonly day: string;
  readonly audioSecondsUsed: number;
  readonly audioSecondsLimit: number;
  readonly transcribeCallsUsed: number;
  readonly transcribeCallsLimit: number;
  readonly chatCallsUsed: number;
  readonly chatCallsLimit: number;
  /** Next UTC midnight, in epoch seconds. */
  readonly resetsAtEpochSeconds: number;
}

/**
 * Server-side limits, returned so the client renders the truth rather than a
 * compiled-in guess - and so a limit can be tightened without shipping a bundle.
 */
export interface LimitsBody {
  readonly maxAudioBytes: number;
  readonly maxAudioSeconds: number;
  readonly maxTextChars: number;
  readonly maxInstructionChars: number;
}

export interface MeResponse {
  readonly user: {
    readonly id: string;
    readonly email: string;
    /** Names, jargon and abbreviations, biased into transcription. */
    readonly vocabulary: string;
  };
  readonly quota: QuotaBody;
  readonly limits: LimitsBody;
  readonly service: { readonly available: boolean; readonly reason?: "global-spend-cap" };
}

export interface TranscribeResponse {
  readonly text: string;
  /** Server-observed audio length, so the client can show usage without a poll. */
  readonly durationSeconds: number;
  readonly quota?: QuotaBody;
}

export interface CleanupRequest {
  readonly text: string;
}

export interface RewriteRequest {
  readonly text: string;
  readonly instruction: string;
}

export interface TextResponse {
  readonly text: string;
  readonly quota?: QuotaBody;
}

export interface UpdateMeRequest {
  readonly vocabulary: string;
}

export interface RequestLinkRequest {
  readonly email: string;
  readonly inviteCode?: string;
}

export interface RequestLinkResponse {
  readonly status: "sent";
  /** Only present when the Worker runs with EMAIL_MODE=console. */
  readonly devLink?: string;
}

/** Required on every fetch-issued request; a cross-site form cannot set it. */
export const CLIENT_HEADER = "X-RB-Client";
export const CLIENT_HEADER_VALUE = "1";

/** Optional language hint on POST /v1/transcribe. */
export const LANGUAGE_HEADER = "X-RB-Language";
