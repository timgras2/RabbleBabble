import { CLEANUP_MODEL, TRANSCRIPTION_MODEL } from "../../../src/shared/models";
import { defaultFetch } from "../http/fetcher";
import type { ChatMessage } from "../../../src/shared/prompts";
import {
  internalError,
  rateLimited,
  upstreamInvalid,
  upstreamTimeout,
  upstreamUnavailable,
} from "../errors";

const CHAT_TIMEOUT_MS = 30_000;
/**
 * Sized against the platform, not against Groq.
 *
 * Cloudflare's edge returns its own 524 at roughly 100s, so anything slower
 * than that hands the user a Cloudflare error page instead of the JSON error
 * envelope the entire client error model is built on. Two attempts at 45s
 * plus one backoff is a 91s worst case; the old 3 x 120s was 363s.
 */
const TRANSCRIPTION_TIMEOUT_MS = 45_000;
const RETRY_BACKOFF_MS = 1_000;
const MAX_ATTEMPTS = 2;

/** Bounds a runaway completion, which settle() is otherwise free to overshoot. */
const MAX_COMPLETION_TOKENS = 2_048;

export interface TranscriptionResult {
  readonly text: string;
  /** Server-observed seconds of audio. The client never gets to assert this. */
  readonly durationSeconds: number | null;
}

export interface ChatResult {
  readonly text: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface GroqGatewayOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetcher?: typeof fetch;
}

/**
 * The Worker's half of what groqClient.ts used to do in the browser: same
 * models, same prompts, same 120s/30s timeouts and 1s/2s backoff, and the same
 * refusal to re-upload audio after a timeout.
 */
export class GroqGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;

  constructor(options: GroqGatewayOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.fetcher = options.fetcher ?? defaultFetch();
  }

  async transcribe(request: {
    readonly audio: ArrayBuffer;
    readonly mimeType: string;
    readonly filename: string;
    readonly language?: string;
    /**
     * Whisper's biasing hint, from the user's saved vocabulary. Read from the
     * session row rather than from the request, so it is still true that a
     * client cannot influence a single field of this form.
     */
    readonly prompt?: string;
  }): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("model", TRANSCRIPTION_MODEL);
    form.append("file", new Blob([request.audio], { type: request.mimeType }), request.filename);
    // The Worker owns this, not the client: metering depends on the duration
    // that only verbose_json returns.
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    if (request.language) {
      form.append("language", request.language);
    }
    if (request.prompt) {
      form.append("prompt", request.prompt);
    }

    const payload = await this.send("/audio/transcriptions", { body: form }, {
      timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
      // The audio is already buffered, so a 5xx retry costs nothing upstream.
      retryTimeouts: false,
    });

    const record = asRecord(payload);
    const text = typeof record.text === "string" ? record.text : "";
    return { text, durationSeconds: readDuration(record) };
  }

  async chat(messages: readonly ChatMessage[]): Promise<ChatResult> {
    const payload = await this.send(
      "/chat/completions",
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CLEANUP_MODEL,
          messages,
          max_completion_tokens: MAX_COMPLETION_TOKENS,
        }),
      },
      { timeoutMs: CHAT_TIMEOUT_MS, retryTimeouts: true },
    );

    const record = asRecord(payload);
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const message = asRecord(asRecord(choices[0]).message);
    const usage = asRecord(record.usage);

    return {
      text: typeof message.content === "string" ? message.content : "",
      promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    };
  }

  private async send(
    path: string,
    init: RequestInit,
    options: { readonly timeoutMs: number; readonly retryTimeouts: boolean },
  ): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          ...init,
          method: "POST",
          headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        lastError = error;
        if (isTimeout(error)) {
          if (!options.retryTimeouts || attempt === MAX_ATTEMPTS - 1) {
            throw upstreamTimeout(error);
          }
        } else if (attempt === MAX_ATTEMPTS - 1) {
          throw upstreamUnavailable(error);
        }
        await backoff(attempt);
        continue;
      }

      if (response.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
        // Assigned even here: without it a pure-5xx sequence logs
        // `internal: "undefined"` for exactly the failure worth debugging.
        lastError = new Error(`groq ${response.status}`);
        await backoff(attempt);
        continue;
      }
      if (!response.ok) {
        throw await mapUpstreamStatus(response);
      }

      try {
        return await response.json();
      } catch (error) {
        throw upstreamInvalid(error);
      }
    }

    throw upstreamUnavailable(lastError);
  }
}

async function mapUpstreamStatus(response: Response): Promise<Error> {
  // A rejected central key is our configuration problem. Surfacing it as
  // api-unauthorized would tell the user to fix a key setting they do not have.
  if (response.status === 401 || response.status === 403) {
    console.error(`[groq] central API key rejected with status ${response.status}`);
    return internalError(`groq auth ${response.status}`);
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After") ?? "");
    return rateLimited(
      "upstream-rate-limited",
      "The transcription service is busy. Try again in a moment.",
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  if (response.status === 413) {
    return upstreamInvalid("groq 413");
  }
  if (response.status >= 500) {
    return upstreamUnavailable(`groq ${response.status}`);
  }
  return upstreamInvalid(`groq ${response.status}`);
}

function readDuration(record: Record<string, unknown>): number | null {
  if (typeof record.duration === "number" && Number.isFinite(record.duration)) {
    return record.duration;
  }
  // Fallback for a response shape without a top-level duration.
  const segments = Array.isArray(record.segments) ? record.segments : [];
  let end = 0;
  for (const segment of segments) {
    const value = asRecord(segment).end;
    if (typeof value === "number" && Number.isFinite(value) && value > end) {
      end = value;
    }
  }
  return end > 0 ? end : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "TimeoutError";
}

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * 2 ** attempt));
}
