import type { Unsubscribe } from "../types";

export interface Settings {
  readonly groqApiKey: string;
  readonly cleanupEnabled: boolean;
  readonly language: string;
  /**
   * Keeps the last few transcripts on this device. Off by default, and it
   * stays off unless asked for: the honest use case is "I copied it, the
   * target app crashed, my words are gone", not a feed.
   */
  readonly historyEnabled: boolean;
}

export type SettingsPatch = Partial<Settings>;

export interface SettingsRepository {
  get(): Settings;
  update(patch: SettingsPatch): Settings;
  clearApiKey(): Settings;
  reset(): Settings;
  subscribe(listener: (settings: Settings) => void): Unsubscribe;
}
