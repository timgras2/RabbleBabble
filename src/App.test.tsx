import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { testServices } from "./test/services";

describe("App", () => {
  it("moves focus to the new screen when navigating", async () => {
    render(<App services={testServices()} />);

    await userEvent.click(screen.getByRole("button", { name: /open settings/i }));

    // Swapping <main> without this leaves a keyboard user on a button that no
    // longer exists, and says nothing about where they now are.
    await waitFor(() => {
      const main = screen.getByRole("main");
      expect(document.activeElement).toBe(main);
    });
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
  });

  it("gives every screen exactly one level-one heading", async () => {
    render(<App services={testServices()} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /open settings/i }));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});
