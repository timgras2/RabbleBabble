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
   * Returns when a request would be accepted right now, and throws an
   * AdapterError otherwise: "missing-api-key" in bring-your-own-key builds,
   * "not-authenticated" or "quota-exceeded" in service builds.
   *
   * Callers check this BEFORE recording starts, never after, so a dead session
   * costs the user no speech.
   *
   * **Synchronous by contract.** It performs no I/O -- each adapter answers
   * from state it already holds -- and it sits between the record tap and
   * getUserMedia, where a single await loses the user activation WebKit needs
   * to prompt for the microphone. See boundary rule 11 in architecture.md.
   */
  checkReady(): void;

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
