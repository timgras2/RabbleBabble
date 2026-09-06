import type { Unsubscribe } from "../types";
import type { Settings, SettingsPatch, SettingsRepository } from "./types";

export const SETTINGS_STORAGE_KEY = "rabblebabble.settings";
export const LEGACY_SETTINGS_STORAGE_KEY = "openwhispr.settings";

export const DEFAULT_SETTINGS: Settings = {
  groqApiKey: "",
  cleanupEnabled: true,
  language: "",
  // The default carries the identity. Anything else and "nothing is saved as
  // history" would need an asterisk.
  historyEnabled: false,
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
      historyEnabled: patch.historyEnabled ?? this.settings.historyEnabled,
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
      if (raw !== null) {
        return this.parse(raw) ?? { ...DEFAULT_SETTINGS };
      }

      const legacyRaw = this.storage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
      if (legacyRaw === null) {
        return { ...DEFAULT_SETTINGS };
      }

      const migrated = this.parse(legacyRaw);
      if (!migrated) {
        return { ...DEFAULT_SETTINGS };
      }

      this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(migrated));
      this.storage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
      return migrated;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private parse(raw: string): Settings | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      const value = parsed as Partial<Settings>;
      return {
        groqApiKey: typeof value.groqApiKey === "string" ? value.groqApiKey : "",
        cleanupEnabled:
          typeof value.cleanupEnabled === "boolean"
            ? value.cleanupEnabled
            : DEFAULT_SETTINGS.cleanupEnabled,
        language: typeof value.language === "string" ? value.language : "",
        historyEnabled: value.historyEnabled === true,
      };
    } catch {
      return null;
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
