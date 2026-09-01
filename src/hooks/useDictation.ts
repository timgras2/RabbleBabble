import { useState, useSyncExternalStore } from "react";
import type { AppServices } from "../app/types";
import { AdapterError } from "../platform/errors";
import type { DictationState } from "../services/types";

export function useDictation(services: AppServices) {
  const flow = services.dictation;
  const state = useSyncExternalStore(
    (listener) => flow.subscribe(listener),
    () => flow.state,
    (): DictationState => "idle",
  );
  const [error, setError] = useState<AdapterError | null>(null);

  const start = async () => {
    setError(null);
    try {
      await flow.start();
    } catch (caught) {
      setError(asAdapterError(caught));
      throw caught;
    }
  };

  const stop = async () => {
    try {
      return await flow.stop();
    } catch (caught) {
      setError(asAdapterError(caught));
      throw caught;
    }
  };

  const cancel = async () => {
    await flow.cancel();
    setError(null);
  };

  return { state, result: flow.result, error, start, stop, cancel };
}

function asAdapterError(error: unknown): AdapterError {
  if (error instanceof AdapterError) {
    return error;
  }
  return new AdapterError("Something went wrong. Try again.", {
    code: "api-server",
    cause: error,
  });
}
