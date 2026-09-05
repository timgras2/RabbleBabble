import type { Unsubscribe } from "../types";

export interface Settings {
  readonly groqApiKey: string;
  readonly cleanupEnabled: boolean;
  readonly language: string;
}

export type SettingsPatch = Partial<Settings>;

export interface SettingsRepository {
  get(): Settings;
  update(patch: SettingsPatch): Settings;
  clearApiKey(): Settings;
  reset(): Settings;
  subscribe(listener: (settings: Settings) => void): Unsubscribe;
}
