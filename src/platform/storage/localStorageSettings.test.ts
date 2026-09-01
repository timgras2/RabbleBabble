import {
  DEFAULT_SETTINGS,
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
      groqApiKey: "test-key",
      cleanupEnabled: true,
      language: "en",
    });
  });

  it("clears only the API key and not other settings", () => {
    const repository = new LocalStorageSettings(localStorage);
    repository.update({ groqApiKey: "test-key", cleanupEnabled: false, language: "de" });
    repository.clearApiKey();

    expect(repository.get()).toEqual({ groqApiKey: "", cleanupEnabled: false, language: "de" });
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
});
