import { AdapterError } from "../errors";
import type { Unsubscribe } from "../types";
import type { AuthSession, AuthState } from "./types";

/**
 * The bring-your-own-key build has no accounts, so this is a null object.
 *
 * It exists so AppServices.session is never optional and useAuthSession can be
 * called unconditionally in App.tsx - which React requires - while the whole
 * service-mode branch still folds away in the BYOK bundle.
 */
const SIGNED_IN: AuthState = {
  status: "signed-in",
  account: null,
  quota: null,
  checking: false,
  error: null,
};

export class LocalAuthSession implements AuthSession {
  get(): AuthState {
    return SIGNED_IN;
  }

  refresh(): Promise<AuthState> {
    return Promise.resolve(SIGNED_IN);
  }

  ensureSignedIn(): Promise<void> {
    return Promise.resolve();
  }

  requestMagicLink(): Promise<void> {
    return Promise.reject(unavailable());
  }

  signOut(): Promise<void> {
    return Promise.reject(unavailable());
  }

  markSignedOut(): void {
    // Nothing to mark: this build has no session to lose.
  }

  updateQuota(): void {
    // No server-side quota in this build.
  }

  subscribe(): Unsubscribe {
    return () => undefined;
  }
}

function unavailable(): AdapterError {
  return new AdapterError("This build does not use accounts.", { code: "api-invalid" });
}
