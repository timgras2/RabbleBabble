import { AdapterError } from "../errors";
import { isRecord, RetryingHttp } from "../http/httpRetry";
import type { HttpErrorMapper } from "../http/httpRetry";
import { MAX_AUDIO_BYTES, MAX_INSTRUCTION_CHARS, MAX_TEXT_CHARS } from "../../shared/limits";
import { CLEANUP_MODEL, TRANSCRIPTION_MODEL } from "../../shared/models";
import { buildCleanupMessages, buildRewriteMessages } from "../../shared/prompts";
import type { AudioRecording } from "../audio/types";
import type {
  CleanupResponse,
  InferenceClient,
  InferenceClientOptions,
  RewriteResponse,
  TranscriptionResponse,
} from "./types";

/**
 * Reads the current key at call time. Injected from the composition root so
 * this adapter never touches storage, and so editing the key in Settings
 * takes effect on the next request rather than the next reload.
 */
export type ApiKeyProvider = () => string;

export interface GroqClientOptions extends InferenceClientOptions {
  readonly apiKey: ApiKeyProvider;
}

export { CLEANUP_MODEL, TRANSCRIPTION_MODEL };

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_CHAT_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120_000;

/**
 * How Groq's failures read to a bring-your-own-key user. The Worker gets its
 * own mapper: a rejected API key and an expired session must not share wording.
 */
const groqErrors: HttpErrorMapper = {
  fromResponse: (response) => Promise.resolve(statusError(response.status)),
  unreachable: (cause) =>
    new AdapterError("Could not reach Groq.", { code: "api-server", retryable: true, cause }),
  timedOut: (cause) =>
    new AdapterError("Groq request timed out.", { code: "api-timeout", retryable: true, cause }),
  invalidBody: (cause) =>
    new AdapterError("Groq returned an invalid response.", { code: "api-invalid", cause }),
};

export class GroqHttpClient implements InferenceClient {
  private readonly apiKey: ApiKeyProvider;
  private readonly baseUrl: string;
  private readonly http: RetryingHttp;
  private readonly chatTimeoutMs: number;
  private readonly transcriptionTimeoutMs: number;

  constructor(options: GroqClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.http = new RetryingHttp({ fetcher: options.fetcher, errors: groqErrors });
    this.chatTimeoutMs = options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    this.transcriptionTimeoutMs =
      options.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
  }

  async transcribe(request: {
    readonly audio: AudioRecording;
    readonly language?: string;
    readonly vocabulary?: string;
    readonly signal?: AbortSignal;
  }): Promise<TranscriptionResponse> {
    const apiKey = this.apiKey();
    this.validateKey(apiKey);
    if (request.audio.blob.size > MAX_AUDIO_BYTES) {
      throw new AdapterError("Recording exceeds the 25 MB upload limit.", {
        code: "recording-too-large",
      });
    }

    const form = new FormData();
    form.append("model", TRANSCRIPTION_MODEL);
    form.append("file", request.audio.blob, filenameForMime(request.audio.mimeType));
    if (request.language?.trim()) {
      form.append("language", request.language.trim());
    }
    if (request.vocabulary?.trim()) {
      form.append("prompt", request.vocabulary.trim());
    }

    const response = await this.http.send(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: request.signal,
    }, { timeoutMs: this.transcriptionTimeoutMs, retryTimeouts: false });
    const payload = await this.http.readJson(response);
    const text = isRecord(payload) && typeof payload.text === "string" ? payload.text : undefined;
    if (typeof text !== "string" || !text.trim()) {
      throw new AdapterError("Groq returned an empty transcript.", {
        code: "empty-transcript",
      });
    }
    return { text };
  }

  async cleanup(request: {
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<CleanupResponse> {
    const apiKey = this.apiKey();
    this.validateKey(apiKey);
    if (!request.text.trim()) {
      throw new AdapterError("There is no transcript to clean up.", {
        code: "empty-transcript",
      });
    }

    const response = await this.http.send(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLEANUP_MODEL,
        messages: buildCleanupMessages(request.text),
      }),
      signal: request.signal,
    }, { timeoutMs: this.chatTimeoutMs });
    const payload = await this.http.readJson(response);
    const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
    const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
    const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : undefined;
    const text = message && typeof message.content === "string" ? message.content : undefined;
    if (typeof text !== "string" || !text.trim()) {
      throw new AdapterError("Groq returned empty cleanup text.", {
        code: "empty-transcript",
      });
    }
    return { text };
  }

  async rewrite(request: {
    readonly text: string;
    readonly instruction: string;
    readonly signal?: AbortSignal;
  }): Promise<RewriteResponse> {
    const apiKey = this.apiKey();
    this.validateKey(apiKey);
    if (!request.text.trim()) {
      throw new AdapterError("There is no transcript to rewrite.", {
        code: "empty-transcript",
      });
    }
    if (!request.instruction.trim()) {
      throw new AdapterError("Enter an instruction for the rewrite.", {
        code: "invalid-instruction",
      });
    }
    if (
      request.text.length > MAX_TEXT_CHARS ||
      request.instruction.length > MAX_INSTRUCTION_CHARS
    ) {
      throw new AdapterError("The transcript or rewrite instruction is too long.", {
        code: "rewrite-too-large",
      });
    }

    const response = await this.http.send(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLEANUP_MODEL,
        messages: buildRewriteMessages(request.text, request.instruction),
      }),
      signal: request.signal,
    }, { timeoutMs: this.chatTimeoutMs });
    const payload = await this.http.readJson(response);
    const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
    const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
    const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : undefined;
    const text = message && typeof message.content === "string" ? message.content : undefined;
    if (typeof text !== "string" || !text.trim()) {
      throw new AdapterError("Groq returned empty rewrite text.", {
        code: "empty-transcript",
      });
    }
    return { text };
  }

  checkReady(): void {
    this.validateKey(this.apiKey());
  }

  private validateKey(apiKey: string): void {
    if (!apiKey.trim()) {
      throw new AdapterError("Enter a Groq API key in Settings first.", {
        code: "missing-api-key",
      });
    }
  }
}

function filenameForMime(mimeType: string): string {
  return mimeType.toLowerCase().includes("mp4") ? "rabblebabble-recording.mp4" : "rabblebabble-recording.webm";
}

function statusError(status: number): AdapterError {
  if (status === 401 || status === 403) {
    return new AdapterError("Groq rejected the API key. Replace it in Settings.", {
      code: "api-unauthorized",
    });
  }
  if (status === 429) {
    return new AdapterError("Groq rate limit reached. Try again later.", {
      code: "api-rate-limited",
      retryable: true,
    });
  }
  if (status >= 400 && status < 500) {
    return new AdapterError("Groq rejected the request.", { code: "api-invalid" });
  }
  return new AdapterError("Groq returned a server error.", {
    code: "api-server",
    retryable: true,
  });
}
