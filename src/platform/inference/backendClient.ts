import { MAX_AUDIO_BYTES, MAX_INSTRUCTION_CHARS, MAX_TEXT_CHARS } from "../../shared/limits";
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, LANGUAGE_HEADER } from "../../shared/wire";
import type { QuotaBody, TextResponse, TranscribeResponse } from "../../shared/wire";
import type { AuthSession, QuotaSnapshot } from "../auth/types";
import { AdapterError } from "../errors";
import { parseApiError } from "../http/apiErrorBody";
import { isRecord, RetryingHttp } from "../http/httpRetry";
import type { HttpErrorMapper } from "../http/httpRetry";
import type { AudioRecording } from "../audio/types";
import type {
  CleanupResponse,
  InferenceClient,
  InferenceClientOptions,
  RewriteResponse,
  TranscriptionResponse,
} from "./types";

const DEFAULT_CHAT_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120_000;

export interface BackendClientOptions extends InferenceClientOptions {
  readonly session: AuthSession;
}

/**
 * Talks to the RabbleBabble Worker instead of to Groq.
 *
 * There is no credential here at all: the session lives in an HttpOnly cookie
 * the page cannot read, which is the point of the whole V2 change.
 */
export class BackendClient implements InferenceClient {
  private readonly baseUrl: string;
  private readonly http: RetryingHttp;
  private readonly session: AuthSession;
  private readonly chatTimeoutMs: number;
  private readonly transcriptionTimeoutMs: number;

  constructor(options: BackendClientOptions) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.session = options.session;
    this.chatTimeoutMs = options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    this.transcriptionTimeoutMs = options.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
    this.http = new RetryingHttp({
      fetcher: options.fetcher,
      errors: backendErrors(() => this.session.markSignedOut()),
    });
  }

  checkReady(): void {
    this.session.requireSignedIn();

    // An optimistic read of the last known snapshot. The server stays
    // authoritative; this just avoids recording into a wall.
    const quota = this.session.get().quota;
    if (quota !== null && quota.audioSecondsUsed >= quota.audioSecondsLimit) {
      throw new AdapterError("You have used today's dictation allowance.", { code: "quota-exceeded" });
    }
  }

  async transcribe(request: {
    readonly audio: AudioRecording;
    readonly language?: string;
    readonly signal?: AbortSignal;
  }): Promise<TranscriptionResponse> {
    // Checked before upload as well as on the server: this saves a doomed
    // 25 MB upload on mobile data, which the server cannot do for us.
    if (request.audio.blob.size > MAX_AUDIO_BYTES) {
      throw new AdapterError("Recording exceeds the 25 MB upload limit.", { code: "recording-too-large" });
    }

    const language = request.language?.trim() ?? "";
    const response = await this.http.send(
      `${this.baseUrl}/v1/transcribe`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": request.audio.mimeType,
          [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
          ...(language === "" ? {} : { [LANGUAGE_HEADER]: language }),
        },
        // Raw bytes, not multipart: the Worker owns the Groq form so a client
        // cannot pick the model or dodge duration-based metering.
        body: request.audio.blob,
        signal: request.signal,
      },
      { timeoutMs: this.transcriptionTimeoutMs, retryTimeouts: false },
    );

    const payload = (await this.http.readJson(response)) as TranscribeResponse;
    this.absorbQuota(payload.quota);
    return { text: this.requireText(payload.text, "RabbleBabble returned an empty transcript.") };
  }

  async cleanup(request: { readonly text: string; readonly signal?: AbortSignal }): Promise<CleanupResponse> {
    if (!request.text.trim()) {
      throw new AdapterError("There is no transcript to clean up.", { code: "empty-transcript" });
    }
    if (request.text.length > MAX_TEXT_CHARS) {
      throw new AdapterError("The transcript is too long.", { code: "rewrite-too-large" });
    }

    const payload = await this.postJson("/v1/cleanup", { text: request.text }, request.signal);
    return { text: this.requireText(payload.text, "RabbleBabble returned empty cleanup text.") };
  }

  async rewrite(request: {
    readonly text: string;
    readonly instruction: string;
    readonly signal?: AbortSignal;
  }): Promise<RewriteResponse> {
    if (!request.text.trim()) {
      throw new AdapterError("There is no transcript to rewrite.", { code: "empty-transcript" });
    }
    if (!request.instruction.trim()) {
      throw new AdapterError("Enter an instruction for the rewrite.", { code: "invalid-instruction" });
    }
    if (request.text.length > MAX_TEXT_CHARS || request.instruction.length > MAX_INSTRUCTION_CHARS) {
      throw new AdapterError("The transcript or rewrite instruction is too long.", { code: "rewrite-too-large" });
    }

    const payload = await this.postJson(
      "/v1/rewrite",
      { text: request.text, instruction: request.instruction },
      request.signal,
    );
    return { text: this.requireText(payload.text, "RabbleBabble returned empty rewrite text.") };
  }

  private async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<TextResponse> {
    const response = await this.http.send(
      `${this.baseUrl}${path}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
        body: JSON.stringify(body),
        signal,
      },
      { timeoutMs: this.chatTimeoutMs },
    );

    const payload = (await this.http.readJson(response)) as TextResponse;
    this.absorbQuota(payload.quota);
    return payload;
  }

  /** Usage rides along on every success, so Settings is fresh without a poll. */
  private absorbQuota(quota: QuotaBody | undefined): void {
    if (!isRecord(quota)) {
      return;
    }
    const snapshot: QuotaSnapshot = {
      audioSecondsUsed: quota.audioSecondsUsed,
      audioSecondsLimit: quota.audioSecondsLimit,
      chatCallsUsed: quota.chatCallsUsed,
      chatCallsLimit: quota.chatCallsLimit,
      resetsAtEpochSeconds: quota.resetsAtEpochSeconds,
    };
    this.session.updateQuota(snapshot);
  }

  private requireText(text: unknown, message: string): string {
    if (typeof text !== "string" || !text.trim()) {
      throw new AdapterError(message, { code: "empty-transcript" });
    }
    return text;
  }
}

function backendErrors(onSignedOut: () => void): HttpErrorMapper {
  return {
    async fromResponse(response) {
      const parsed = await parseApiError(response);

      if (parsed !== null) {
        if (parsed.code === "not-authenticated") {
          // Recorded without an extra round trip, so the UI can react at once.
          onSignedOut();
        }
        return parsed.error;
      }

      if (response.status === 401 || response.status === 403) {
        onSignedOut();
        return new AdapterError("Your session ended.", { code: "not-authenticated" });
      }
      if (response.status === 413) {
        return new AdapterError("That recording is too large.", { code: "recording-too-large" });
      }
      if (response.status === 429) {
        return new AdapterError("Too many requests. Try again shortly.", {
          code: "api-rate-limited",
          retryable: true,
        });
      }
      if (response.status >= 500) {
        return new AdapterError("RabbleBabble is having trouble.", { code: "api-server", retryable: true });
      }
      return new AdapterError("RabbleBabble rejected the request.", { code: "api-invalid" });
    },
    unreachable: (cause) =>
      new AdapterError("Could not reach RabbleBabble.", { code: "api-server", retryable: true, cause }),
    timedOut: (cause) =>
      new AdapterError("RabbleBabble took too long to answer.", { code: "api-timeout", retryable: true, cause }),
    invalidBody: (cause) =>
      new AdapterError("RabbleBabble returned an invalid response.", { code: "api-invalid", cause }),
  };
}
