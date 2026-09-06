import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from "../../shared/wire";
import type { MeResponse } from "../../shared/wire";
import { AdapterError } from "../errors";
import { isRecord, RetryingHttp } from "../http/httpRetry";
import type { HttpErrorMapper } from "../http/httpRetry";
import { parseApiError } from "../http/apiErrorBody";
import type { Unsubscribe } from "../types";
import type { AuthSession, AuthState, QuotaSnapshot } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;

const INITIAL_STATE: AuthState = {
  status: "unknown",
  account: null,
  quota: null,
  checking: false,
  error: null,
};

export interface HttpAuthSessionOptions {
  /** "" when the Worker answers on this origin, which is the intended shape. */
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly revalidateOnFocus?: boolean;
}

export class HttpAuthSession implements AuthSession {
  private state: AuthState = INITIAL_STATE;
  private readonly listeners = new Set<(state: AuthState) => void>();
  private readonly http: RetryingHttp;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private inFlight: Promise<AuthState> | null = null;

  constructor(options: HttpAuthSessionOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.http = new RetryingHttp({ fetcher: options.fetcher, errors: authErrors });

    // The magic link opens in Chrome, not necessarily in the installed PWA.
    // Without this the user signs in in one surface and the installed app
    // still shows a sign-in form until they think to reload.
    if ((options.revalidateOnFocus ?? true) && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && !this.state.checking) {
          void this.refresh();
        }
      });
    }
  }

  get(): AuthState {
    return this.state;
  }

  refresh(): Promise<AuthState> {
    // Several callers on boot must not become several requests.
    if (this.inFlight !== null) {
      return this.inFlight;
    }

    this.setState({ ...this.state, checking: true });
    const operation = this.fetchMe().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }

  requireSignedIn(): void {
    const state = this.state;
    if (state.status === "signed-in") {
      return;
    }
    if (state.status === "unknown") {
      // Cannot await the answer here without losing the microphone gesture, so
      // start the check for next time and report what we know now.
      void this.refresh();
      throw (
        state.error ??
        new AdapterError("Could not reach RabbleBabble.", { code: "offline", retryable: true })
      );
    }
    throw new AdapterError("Sign in to start dictating.", { code: "not-authenticated" });
  }

  async requestMagicLink(request: {
    readonly email: string;
    readonly inviteCode?: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    await this.http.send(
      `${this.baseUrl}/auth/request-link`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
        body: JSON.stringify({
          email: request.email,
          ...(request.inviteCode ? { inviteCode: request.inviteCode } : {}),
        }),
        signal: request.signal,
      },
      // One attempt only: a flaky 5xx must never send a second email.
      { timeoutMs: this.timeoutMs, maxAttempts: 1 },
    );
  }

  async signOut(options: { readonly allDevices?: boolean } = {}): Promise<void> {
    try {
      await this.http.send(
        `${this.baseUrl}/auth/logout`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
          // The client used to send no body at all, and the server read the
          // flag as the string "true", so "sign out everywhere" was two
          // independent no-ops stacked on each other.
          body: JSON.stringify({ allDevices: options.allDevices === true }),
        },
        { timeoutMs: this.timeoutMs, maxAttempts: 1 },
      );
    } catch {
      // Signing out locally must happen whether or not the server agreed.
    }
    this.markSignedOut();
  }

  async deleteAccount(): Promise<void> {
    await this.http.send(
      `${this.baseUrl}/v1/me`,
      {
        method: "DELETE",
        credentials: "include",
        headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
      },
      // One attempt: a retried delete on a row that is already gone is
      // harmless, but a 404 surfacing as a failure is not worth the noise.
      { timeoutMs: this.timeoutMs, maxAttempts: 1 },
    );
    this.markSignedOut();
  }

  markSignedOut(): void {
    if (this.state.status === "signed-out" && this.state.account === null) {
      return;
    }
    this.setState({ status: "signed-out", account: null, quota: null, checking: false, error: null });
  }

  updateQuota(quota: QuotaSnapshot): void {
    this.setState({ ...this.state, quota });
  }

  subscribe(listener: (state: AuthState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async fetchMe(): Promise<AuthState> {
    try {
      const response = await this.http.send(
        `${this.baseUrl}/v1/me`,
        {
          method: "GET",
          credentials: "include",
          headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
        },
        { timeoutMs: this.timeoutMs, maxAttempts: 2 },
      );

      const payload = (await this.http.readJson(response)) as MeResponse;
      this.setState({
        status: "signed-in",
        account: { email: payload.user.email },
        quota: toQuota(payload),
        checking: false,
        error: null,
      });
    } catch (error) {
      const code = error instanceof AdapterError ? error.code : undefined;
      if (code === "not-authenticated" || code === "api-unauthorized") {
        this.markSignedOut();
      } else {
        // A transport failure is NOT a signed-out answer. Showing an
        // offline-but-signed-in user a sign-in form is a lie, and a dead end:
        // signing in is exactly what they cannot do right now.
        this.setState({
          ...this.state,
          checking: false,
          error: error instanceof AdapterError ? error : null,
        });
      }
    }

    return this.state;
  }

  private setState(next: AuthState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

function toQuota(payload: MeResponse): QuotaSnapshot | null {
  if (!isRecord(payload.quota)) {
    return null;
  }
  return {
    audioSecondsUsed: payload.quota.audioSecondsUsed,
    audioSecondsLimit: payload.quota.audioSecondsLimit,
    chatCallsUsed: payload.quota.chatCallsUsed,
    chatCallsLimit: payload.quota.chatCallsLimit,
    resetsAtEpochSeconds: payload.quota.resetsAtEpochSeconds,
  };
}

const authErrors: HttpErrorMapper = {
  async fromResponse(response) {
    const parsed = await parseApiError(response);
    if (parsed !== null) {
      return parsed.error;
    }
    if (response.status === 401 || response.status === 403) {
      return new AdapterError("Sign in to continue.", { code: "not-authenticated" });
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
