import { AdapterError } from "../errors";

/**
 * Retry, timeout and abort handling for outbound HTTP, shared by every adapter
 * that talks to a network service.
 *
 * What stays here is the timing: the attempt loop, the timeout race, the
 * abortable backoff. What does NOT stay here is what a failure means. A 401
 * from Groq means "your API key is wrong, open Settings"; a 401 from the
 * RabbleBabble Worker means "your session ended, sign in". Those are different
 * products speaking, so each adapter supplies its own HttpErrorMapper.
 */

export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 1_000;

export interface HttpErrorMapper {
  /** A non-2xx response that will not be retried. May read the body. */
  fromResponse(response: Response): Promise<AdapterError>;
  /** Every attempt failed with a transport error. */
  unreachable(cause?: unknown): AdapterError;
  /** An attempt exceeded its timeout and will not be retried. */
  timedOut(cause?: unknown): AdapterError;
  /** A 2xx body was not valid JSON. */
  invalidBody(cause?: unknown): AdapterError;
}

export interface HttpSendOptions {
  readonly timeoutMs: number;
  /**
   * Defaults to true. Transcription passes false: re-uploading 25 MB on a
   * metered connection because the first try was slow is hostile, so a
   * timeout there fails fast and the user decides whether to retry.
   */
  readonly retryTimeouts?: boolean;
  /** Defaults to MAX_ATTEMPTS. Auth posts pass 1 so no second email is sent. */
  readonly maxAttempts?: number;
}

class RequestTimeoutError extends Error {}

export class RetryingHttp {
  private readonly fetcher: typeof fetch;
  private readonly errors: HttpErrorMapper;

  constructor(options: { readonly fetcher?: typeof fetch; readonly errors: HttpErrorMapper }) {
    this.fetcher = options.fetcher ?? defaultFetcher();
    this.errors = options.errors;
  }

  async send(
    url: string,
    init: RequestInit & { signal?: AbortSignal },
    options: HttpSendOptions,
  ): Promise<Response> {
    // Checked here rather than left to the fetcher: a caller who already
    // cancelled deserves "cancelled", not whatever the transport happens to do.
    if (init.signal?.aborted) {
      throw new AdapterError("The request was cancelled.", { code: "cancelled" });
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new AdapterError("The device is offline.", { code: "offline", retryable: true });
    }

    const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    let lastNetworkError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchAttempt(url, init, options.timeoutMs);
        const isServerError = response.status >= 500 && response.status <= 599;
        if (isServerError && attempt < maxAttempts - 1) {
          await waitBeforeRetry(attempt, init.signal);
          continue;
        }
        if (!response.ok) {
          throw await this.errors.fromResponse(response);
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
          if (options.retryTimeouts === false || attempt === maxAttempts - 1) {
            throw this.errors.timedOut(error);
          }
          await waitBeforeRetry(attempt, init.signal);
          continue;
        }
        lastNetworkError = error;
        if (attempt === maxAttempts - 1) {
          throw this.errors.unreachable(lastNetworkError);
        }
        await waitBeforeRetry(attempt, init.signal);
      }
    }
    throw this.errors.unreachable(lastNetworkError);
  }

  async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw this.errors.invalidBody(error);
    }
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
}

/** Exponential backoff that gives up promptly when the caller aborts. */
function waitBeforeRetry(attempt: number, signal?: AbortSignal): Promise<void> {
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

export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function defaultFetcher(): typeof fetch {
  if (typeof window !== "undefined") {
    return window.fetch.bind(window);
  }
  return fetch;
}
