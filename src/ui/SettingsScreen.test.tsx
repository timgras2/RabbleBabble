import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fakeSettings, testServices } from "../test/services";
import { SettingsScreen } from "./SettingsScreen";

describe("SettingsScreen", () => {
  it("persists the cleanup toggle immediately, because it looks like a switch", async () => {
    const settings = fakeSettings({ cleanupEnabled: false });
    render(<SettingsScreen services={testServices({ settings })} />);

    await userEvent.click(screen.getByRole("switch", { name: /clean up transcripts/i }));

    // Not "on Save". Walking away from Settings used to discard this silently.
    expect(settings.get().cleanupEnabled).toBe(true);
  });

  it("saves the language hint without an explicit save", async () => {
    const settings = fakeSettings({ language: "" });
    render(<SettingsScreen services={testServices({ settings })} />);

    await userEvent.type(screen.getByLabelText(/language hint/i), "nl");
    await userEvent.tab();

    await waitFor(() => expect(settings.get().language).toBe("nl"));
  });

  it("has a real heading, not a header span", () => {
    render(<SettingsScreen services={testServices()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
  });
});

describe("SettingsScreen features", () => {
  it("saves the personal vocabulary when the field is left", async () => {
    const settings = fakeSettings({ vocabulary: "" });
    render(<SettingsScreen services={testServices({ settings })} />);

    await userEvent.type(screen.getByLabelText(/personal vocabulary/i), "  Aisling, EBITDA  ");
    await userEvent.tab();

    await waitFor(() => expect(settings.get().vocabulary).toBe("Aisling, EBITDA"));
  });

  it("keeps on-device history off unless it is asked for", async () => {
    const settings = fakeSettings();
    render(<SettingsScreen services={testServices({ settings })} />);

    // The default carries the identity, so this is the assertion that matters.
    expect(settings.get().historyEnabled).toBe(false);
    expect(screen.queryByRole("button", { name: /clear history/i })).toBeNull();

    await userEvent.click(screen.getByRole("switch", { name: /keep transcripts on this device/i }));

    expect(settings.get().historyEnabled).toBe(true);
    // And it is clearable in one tap the moment it is on.
    expect(screen.getByRole("button", { name: /clear history/i })).toBeTruthy();
  });
});
