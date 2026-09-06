import { registerSW } from "virtual:pwa-register";

/**
 * A deploy must never take a transcript away.
 *
 * `registerType: "autoUpdate"` with `immediate: true` compiles to a
 * `location.reload()` on controller change, so shipping a build while someone
 * held an uncopied transcript -- or was mid-recording -- destroyed it. The new
 * worker now waits, and the app asks.
 */
class UpdatePrompt {
  private pending = false;
  private readonly listeners = new Set<() => void>();
  private activate: ((reload?: boolean) => Promise<void>) | null = null;

  register(): void {
    if (this.activate !== null) {
      return;
    }
    this.activate = registerSW({
      immediate: true,
      onNeedRefresh: () => {
        this.pending = true;
        this.notify();
      },
    });
  }

  getSnapshot(): boolean {
    return this.pending;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Only ever called from a control the user pressed. */
  apply(): void {
    void this.activate?.(true);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const updatePrompt = new UpdatePrompt();

export function registerPwa(): void {
  updatePrompt.register();
}
