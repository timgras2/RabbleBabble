import { useSyncExternalStore } from "react";
import { updatePrompt } from "../pwa/register";

/**
 * Whether a new build is waiting, and how to take it.
 *
 * `safe` is false while the user has words that only exist on this page. The
 * update keeps waiting -- the service worker is patient -- and the offer
 * reappears once the transcript has been dealt with.
 */
export function useUpdatePrompt(safe: boolean) {
  const pending = useSyncExternalStore(
    (listener) => updatePrompt.subscribe(listener),
    () => updatePrompt.getSnapshot(),
    () => false,
  );

  return { offer: pending && safe, apply: () => updatePrompt.apply() };
}
