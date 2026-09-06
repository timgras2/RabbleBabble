/**
 * Stands in for `virtual:pwa-register`, which only exists inside a Vite build.
 * The tests care about the update-prompt state machine, not about workbox.
 */
export function registerSW(options?: {
  immediate?: boolean;
  onNeedRefresh?: () => void;
}): (reload?: boolean) => Promise<void> {
  void options;
  return async () => undefined;
}
