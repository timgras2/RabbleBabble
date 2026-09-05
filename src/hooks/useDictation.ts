import { useState, useSyncExternalStore } from "react";
import type { AppServices } from "../app/types";
import { AdapterError } from "../platform/errors";
import type { DictationResult, DictationState } from "../services/types";

export function useDictation(services: AppServices) {
  const flow = services.dictation;
  const state = useSyncExternalStore(
    (listener) => flow.subscribe(listener),
    () => flow.state,
    (): DictationState => "idle",
  );
  const result = useSyncExternalStore(
    (listener) => flow.subscribe(listener),
    () => flow.result,
    (): DictationResult | null => null,
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

  const rewrite = async (instruction: string) => {
    setError(null);
    try {
      return await flow.rewrite(instruction);
    } catch (caught) {
      const error = asAdapterError(caught);
      if (error.code !== "cancelled") {
        setError(error);
      }
      throw caught;
    }
  };

  const cancel = async () => {
    await flow.cancel();
    setError(null);
  };

  return { state, result, error, start, stop, rewrite, cancel };
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
