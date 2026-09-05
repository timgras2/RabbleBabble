import { useEffect, useSyncExternalStore } from "react";
import type { AppServices } from "../app/types";

export function useAuthSession(services: AppServices) {
  const session = services.session;
  const state = useSyncExternalStore(
    (listener) => session.subscribe(() => listener()),
    () => session.get(),
    () => session.get(),
  );

  // Covers a remount after the magic-link redirect, when the app boots with no
  // idea yet whether the cookie it now holds is any good.
  useEffect(() => {
    if (state.status === "unknown" && !state.checking && state.error === null) {
      void session.refresh();
    }
  }, [session, state.status, state.checking, state.error]);

  return {
    ...state,
    refresh: () => session.refresh(),
    requestMagicLink: session.requestMagicLink.bind(session),
    signOut: () => session.signOut(),
  };
}

/**
 * Whether a transcript is currently on screen.
 *
 * Used to decide whether an expired session may take over the whole screen:
 * routing away from a completed transcript the user has not copied yet would
 * destroy their words, which is the one thing this app must never do.
 */
export function useHasTranscript(services: AppServices): boolean {
  const flow = services.dictation;
  return useSyncExternalStore(
    (listener) => flow.subscribe(() => listener()),
    () => flow.result !== null,
    () => false,
  );
}
