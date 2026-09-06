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
