import {
  DEFAULT_SETTINGS,
  LEGACY_SETTINGS_STORAGE_KEY,
  LocalStorageSettings,
  SETTINGS_STORAGE_KEY,
} from "./localStorageSettings";

describe("LocalStorageSettings", () => {
  beforeEach(() => localStorage.clear());

  it("reads defaults and persists updates as one value", () => {
    const repository = new LocalStorageSettings(localStorage);
    expect(repository.get()).toEqual(DEFAULT_SETTINGS);

    repository.update({ groqApiKey: "test-key", language: "en" });
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toEqual({
      ...DEFAULT_SETTINGS,
      groqApiKey: "test-key",
      language: "en",
    });
  });

  it("clears only the API key and not other settings", () => {
    const repository = new LocalStorageSettings(localStorage);
    repository.update({ groqApiKey: "test-key", cleanupEnabled: false, language: "de" });
    repository.clearApiKey();

    expect(repository.get()).toEqual({ ...DEFAULT_SETTINGS, groqApiKey: "", cleanupEnabled: false, language: "de" });
  });

  it("notifies subscribers and supports reset", () => {
    const repository = new LocalStorageSettings(localStorage);
    const listener = vi.fn();
    repository.subscribe(listener);
    repository.update({ language: "fr" });
    repository.reset();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(repository.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("migrates valid legacy settings to the RabbleBabble key", () => {
    localStorage.setItem(
      LEGACY_SETTINGS_STORAGE_KEY,
      JSON.stringify({ groqApiKey: "legacy-key", cleanupEnabled: false, language: "de" }),
    );

    const repository = new LocalStorageSettings(localStorage);

    expect(repository.get()).toEqual({ ...DEFAULT_SETTINGS, groqApiKey: "legacy-key", cleanupEnabled: false, language: "de" });
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toEqual(repository.get());
    expect(localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("prefers the new key when both keys exist", () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ groqApiKey: "new-key" }));
    localStorage.setItem(LEGACY_SETTINGS_STORAGE_KEY, JSON.stringify({ groqApiKey: "old-key" }));

    const repository = new LocalStorageSettings(localStorage);

    expect(repository.get().groqApiKey).toBe("new-key");
    expect(localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY)).not.toBeNull();
  });
});
