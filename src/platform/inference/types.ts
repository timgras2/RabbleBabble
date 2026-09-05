import type { AudioRecording } from "../audio/types";

export interface GroqClientOptions {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly transcriptionTimeoutMs?: number;
}

export interface GroqTranscriptionResponse {
  readonly text: string;
}

export interface GroqCleanupResponse {
  readonly text: string;
}

export interface GroqRewriteResponse {
  readonly text: string;
}

export interface GroqClient {
  transcribe(request: {
    readonly apiKey: string;
    readonly audio: AudioRecording;
    readonly language?: string;
    readonly signal?: AbortSignal;
  }): Promise<GroqTranscriptionResponse>;

  cleanup(request: {
    readonly apiKey: string;
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<GroqCleanupResponse>;

  rewrite(request: {
    readonly apiKey: string;
    readonly text: string;
    readonly instruction: string;
    readonly signal?: AbortSignal;
  }): Promise<GroqRewriteResponse>;
}
