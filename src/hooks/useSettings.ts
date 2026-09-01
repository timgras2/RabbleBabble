import { useSyncExternalStore } from "react";
import type { AppServices } from "../app/types";

export function useSettings(services: AppServices) {
  const repository = services.settings;
  const settings = useSyncExternalStore(
    (listener) => repository.subscribe(() => listener()),
    () => repository.get(),
    () => repository.get(),
  );

  return {
    settings,
    ready: true,
    update: repository.update.bind(repository),
    reset: repository.reset.bind(repository),
    clearApiKey: repository.clearApiKey.bind(repository),
  };
}
