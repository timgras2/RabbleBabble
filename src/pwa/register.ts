import { registerSW } from "virtual:pwa-register";

export function registerPwa(): void {
  registerSW({ immediate: true });
}
