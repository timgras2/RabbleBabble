import { useSyncExternalStore } from "react";
import type { AppServices } from "../app/types";
import type { DictationSnapshot } from "../services/types";

const IDLE: DictationSnapshot = {
  state: "idle",
  result: null,
  error: null,
  notice: null,
  canRetry: false,
  recoverable: null,
};

/**
 * One subscription to one snapshot.
 *
 * State, result and error used to be read three different ways -- two of them
 * component state -- so navigating away and back lost the error text while
 * leaving the error state behind.
 */
export function useDictation(services: AppServices) {
  const flow = services.dictation;
  const snapshot = useSyncExternalStore(
    (listener) => flow.subscribe(listener),
    () => flow.getSnapshot(),
    () => IDLE,
  );

  return {
    ...snapshot,
    // Rejections are already recorded in the snapshot, so callers that only
    // need to render never have to catch. start() still rethrows, because the
    // recorder screen routes on the code.
    start: () => flow.start(),
    stop: () => flow.stop(),
    retryUpload: () => flow.retryUpload(),
    recoverBuffered: () => flow.recoverBuffered(),
    discardBuffered: () => flow.discardBuffered(),
    rewrite: (instruction: string) => flow.rewrite(instruction),
    cancel: () => flow.cancel(),
  };
}
