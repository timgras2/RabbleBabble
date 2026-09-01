import type { Unsubscribe } from "../types";
import type { Settings, SettingsPatch, SettingsRepository } from "./types";

export const SETTINGS_STORAGE_KEY = "openwhispr.settings";

export const DEFAULT_SETTINGS: Settings = {
  groqApiKey: "",
  cleanupEnabled: true,
  language: "",
};

export class LocalStorageSettings implements SettingsRepository {
  private readonly storage: Storage;
  private readonly listeners = new Set<(settings: Settings) => void>();
  private settings: Settings;

  constructor(storage: Storage = window.localStorage) {
    this.storage = storage;
    this.settings = this.read();
  }

  get(): Settings {
    return this.settings;
  }

  update(patch: SettingsPatch): Settings {
    this.settings = {
      ...this.settings,
      ...patch,
      groqApiKey: patch.groqApiKey ?? this.settings.groqApiKey,
      cleanupEnabled: patch.cleanupEnabled ?? this.settings.cleanupEnabled,
      language: patch.language ?? this.settings.language,
    };
    this.persist();
    this.notify();
    return this.settings;
  }

  clearApiKey(): Settings {
    return this.update({ groqApiKey: "" });
  }

  reset(): Settings {
    this.settings = { ...DEFAULT_SETTINGS };
    this.persist();
    this.notify();
    return this.settings;
  }

  subscribe(listener: (settings: Settings) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private read(): Settings {
    try {
      const raw = this.storage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) {
        return { ...DEFAULT_SETTINGS };
      }
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return { ...DEFAULT_SETTINGS };
      }
      const value = parsed as Partial<Settings>;
      return {
        groqApiKey: typeof value.groqApiKey === "string" ? value.groqApiKey : "",
        cleanupEnabled:
          typeof value.cleanupEnabled === "boolean"
            ? value.cleanupEnabled
            : DEFAULT_SETTINGS.cleanupEnabled,
        language: typeof value.language === "string" ? value.language : "",
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private persist(): void {
    try {
      this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Settings remain usable for this session if storage is unavailable.
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.settings);
    }
  }
}
