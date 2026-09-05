import type { Unsubscribe } from "../types";

export interface Settings {
  readonly groqApiKey: string;
  readonly cleanupEnabled: boolean;
  readonly language: string;
  /** Set after the first finished transcript, so the intro hero shows only once. */
  readonly hasCompletedFirstRun: boolean;
}

export type SettingsPatch = Partial<Settings>;

export interface SettingsRepository {
  get(): Settings;
  update(patch: SettingsPatch): Settings;
  clearApiKey(): Settings;
  reset(): Settings;
  subscribe(listener: (settings: Settings) => void): Unsubscribe;
}
