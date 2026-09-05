import { AdapterError } from "../errors";
import { MAX_AUDIO_BYTES, MAX_INSTRUCTION_CHARS, MAX_TEXT_CHARS } from "../../shared/limits";
import { CLEANUP_MODEL, TRANSCRIPTION_MODEL } from "../../shared/models";
import { buildCleanupMessages, buildRewriteMessages } from "../../shared/prompts";
import type { AudioRecording } from "../audio/types";
import type {
  GroqCleanupResponse,
  GroqClient,
  GroqClientOptions,
  GroqRewriteResponse,
  GroqTranscriptionResponse,
} from "./types";

export { CLEANUP_MODEL, TRANSCRIPTION_MODEL };

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_CHAT_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120_000;
const RETRY_BACKOFF_MS = 1_000;
const MAX_ATTEMPTS = 3;

class RequestTimeoutError extends Error {}

export class GroqHttpClient implements GroqClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly chatTimeoutMs: number;
  private readonly transcriptionTimeoutMs: number;

  constructor(options: GroqClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetcher = options.fetcher ?? defaultFetcher();
    this.chatTimeoutMs = options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    this.transcriptionTimeoutMs =
      options.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
  }

  async transcribe(request: {
    readonly apiKey: string;
    readonly audio: AudioRecording;
    readonly language?: string;
    readonly signal?: AbortSignal;
  }): Promise<GroqTranscriptionResponse> {
    this.validateKey(request.apiKey);
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

    const response = await this.request(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${request.apiKey}` },
      body: form,
      signal: request.signal,
    }, { timeoutMs: this.transcriptionTimeoutMs, retryTimeouts: false });
    const payload = await this.readJson(response);
    const text = isRecord(payload) && typeof payload.text === "string" ? payload.text : undefined;
    if (typeof text !== "string" || !text.trim()) {
      throw new AdapterError("Groq returned an empty transcript.", {
        code: "empty-transcript",
      });
    }
    return { text };
  }

  async cleanup(request: {
    readonly apiKey: string;
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<GroqCleanupResponse> {
    this.validateKey(request.apiKey);
    if (!request.text.trim()) {
      throw new AdapterError("There is no transcript to clean up.", {
        code: "empty-transcript",
      });
    }

    const response = await this.request(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLEANUP_MODEL,
        messages: buildCleanupMessages(request.text),
      }),
      signal: request.signal,
    }, { timeoutMs: this.chatTimeoutMs });
    const payload = await this.readJson(response);
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
    readonly apiKey: string;
    readonly text: string;
    readonly instruction: string;
    readonly signal?: AbortSignal;
  }): Promise<GroqRewriteResponse> {
    this.validateKey(request.apiKey);
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

    const response = await this.request(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLEANUP_MODEL,
        messages: buildRewriteMessages(request.text, request.instruction),
      }),
      signal: request.signal,
    }, { timeoutMs: this.chatTimeoutMs });
    const payload = await this.readJson(response);
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

  private async request(
    url: string,
    init: RequestInit & { signal?: AbortSignal },
    options: { readonly timeoutMs: number; readonly retryTimeouts?: boolean },
  ): Promise<Response> {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new AdapterError("The device is offline.", { code: "offline", retryable: true });
    }

    let lastNetworkError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchAttempt(url, init, options.timeoutMs);
        if (response.status >= 500 && response.status <= 599) {
          if (attempt < MAX_ATTEMPTS - 1) {
            await this.waitBeforeRetry(attempt, init.signal);
            continue;
          }
          throw new AdapterError("Groq is temporarily unavailable.", {
            code: "api-server",
            retryable: true,
          });
        }
        if (!response.ok) {
          throw statusError(response.status);
        }
        return response;
      } catch (error) {
        if (init.signal?.aborted || isAbortError(error)) {
          throw new AdapterError("The request was cancelled.", { code: "cancelled", cause: error });
        }
        if (error instanceof AdapterError) {
          throw error;
        }
        if (error instanceof RequestTimeoutError) {
          if (options.retryTimeouts === false || attempt === MAX_ATTEMPTS - 1) {
            throw new AdapterError("Groq request timed out.", {
              code: "api-timeout",
              retryable: true,
              cause: error,
            });
          }
          await this.waitBeforeRetry(attempt, init.signal);
          continue;
        }
        lastNetworkError = error;
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new AdapterError("Could not reach Groq.", {
            code: "api-server",
            retryable: true,
            cause: lastNetworkError,
          });
        }
        await this.waitBeforeRetry(attempt, init.signal);
      }
    }
    throw new AdapterError("Could not reach Groq.", {
      code: "api-server",
      retryable: true,
      cause: lastNetworkError,
    });
  }

  private async fetchAttempt(
    url: string,
    init: RequestInit & { signal?: AbortSignal },
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (init.signal) {
      if (init.signal.aborted) {
        controller.abort();
      } else {
        init.signal.addEventListener("abort", abortFromCaller, { once: true });
      }
    }
    let rejectTimeout!: (reason?: unknown) => void;
    const timeout = new Promise<Response>((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout(new RequestTimeoutError());
    }, timeoutMs);

    try {
      return await Promise.race([
        this.fetcher(url, { ...init, signal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      if (timedOut) {
        throw new RequestTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private waitBeforeRetry(attempt: number, signal?: AbortSignal): Promise<void> {
    const delayMs = RETRY_BACKOFF_MS * 2 ** attempt;
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("The request was cancelled.", "AbortError"));
        return;
      }

      const onAbort = () => {
        if (timer) {
          clearTimeout(timer);
        }
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("The request was cancelled.", "AbortError"));
      };

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new AdapterError("Groq returned an invalid response.", {
        code: "api-invalid",
        cause: error,
      });
    }
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

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultFetcher(): typeof fetch {
  if (typeof window !== "undefined") {
    return window.fetch.bind(window);
  }
  return fetch;
}
