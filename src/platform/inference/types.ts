import type { AudioRecording } from "../audio/types";

export interface InferenceClientOptions {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly transcriptionTimeoutMs?: number;
}

export interface TranscriptionResponse {
  readonly text: string;
}

export interface CleanupResponse {
  readonly text: string;
}

export interface RewriteResponse {
  readonly text: string;
}

/**
 * Transcription and text editing, with no opinion about how the caller is
 * authorised. The bring-your-own-key adapter holds a key provider; the backend
 * adapter holds nothing at all, because its session lives in an HttpOnly
 * cookie the page cannot read.
 */
export interface InferenceClient {
  /**
   * Resolves when a request would be accepted right now, and rejects with an
   * AdapterError otherwise: "missing-api-key" in bring-your-own-key builds,
   * "not-authenticated" or "quota-exceeded" in service builds.
   *
   * Callers must await this BEFORE recording starts, never after, so a dead
   * session costs the user no speech. It performs no network round trip: each
   * adapter answers from state it already holds.
   */
  ensureReady(): Promise<void>;

  transcribe(request: {
    readonly audio: AudioRecording;
    readonly language?: string;
    readonly signal?: AbortSignal;
  }): Promise<TranscriptionResponse>;

  cleanup(request: {
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<CleanupResponse>;

  rewrite(request: {
    readonly text: string;
    readonly instruction: string;
    readonly signal?: AbortSignal;
  }): Promise<RewriteResponse>;
}
