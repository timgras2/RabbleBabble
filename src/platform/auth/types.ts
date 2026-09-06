import type { AdapterError } from "../errors";
import type { Unsubscribe } from "../types";

export type AuthStatus = "unknown" | "signed-in" | "signed-out";

export interface AuthAccount {
  readonly email: string;
  /** As the server holds it; the local copy in Settings is the edit buffer. */
  readonly vocabulary: string;
}

export interface QuotaSnapshot {
  readonly audioSecondsUsed: number;
  readonly audioSecondsLimit: number;
  readonly chatCallsUsed: number;
  readonly chatCallsLimit: number;
  /** Epoch seconds of the next reset, so the UI can say when. */
  readonly resetsAtEpochSeconds: number;
}

export interface AuthState {
  readonly status: AuthStatus;
  readonly account: AuthAccount | null;
  readonly quota: QuotaSnapshot | null;
  /** A /v1/me request is in flight. Lets the UI re-check without flashing. */
  readonly checking: boolean;
  /** The last transport failure while checking. Status stays "unknown". */
  readonly error: AdapterError | null;
}

/**
 * Who the user is, according to the backend.
 *
 * The session cookie is HttpOnly, so the page genuinely cannot read it - this
 * port exists because the only way to learn the answer is to ask the server.
 */
export interface AuthSession {
  /**
   * The cached snapshot. Never performs I/O, and returns the SAME object until
   * something actually changes: useSyncExternalStore compares by identity, and
   * a fresh object per call is an infinite render loop rather than a subtle bug.
   */
  get(): AuthState;

  /** Re-reads GET /v1/me. Concurrent callers share one in-flight request. */
  refresh(): Promise<AuthState>;

  /**
   * Returns when the cached status is signed in, and throws otherwise:
   * "not-authenticated" when signed out, or the last transport failure when
   * the status could not be established at all.
   *
   * **Synchronous by contract.** It answers from the cached snapshot and never
   * awaits, because it is called between the record tap and getUserMedia. It
   * may kick off a background refresh, but must not wait for one.
   */
  requireSignedIn(): void;

  requestMagicLink(request: {
    readonly email: string;
    readonly inviteCode?: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;

  /**
   * `allDevices` revokes every session for the account, not just this one.
   * Always sends a body: a missing one is indistinguishable from a false.
   */
  signOut(options?: { readonly allDevices?: boolean }): Promise<void>;

  /** Saves the personal vocabulary the Worker will bias transcription with. */
  saveVocabulary(vocabulary: string): Promise<void>;

  /**
   * Erases the account and everything that cascades from it, then signs out.
   * Irreversible, so the UI confirms before calling it.
   */
  deleteAccount(): Promise<void>;

  /** Records a 401 seen by another adapter, with no extra round trip. */
  markSignedOut(): void;

  /** Accepts the quota block piggy-backed on a successful /v1 response. */
  updateQuota(quota: QuotaSnapshot): void;

  subscribe(listener: (state: AuthState) => void): Unsubscribe;
}
