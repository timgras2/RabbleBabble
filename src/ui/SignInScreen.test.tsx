import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdapterError } from "../platform/errors";
import { fakeSession, testServices } from "../test/services";
import { SignInScreen } from "./SignInScreen";

const SIGNED_OUT = {
  status: "signed-out" as const,
  account: null,
  quota: null,
  checking: false,
  error: null,
};

describe("SignInScreen", () => {
  it("confirms the send without claiming the address exists", async () => {
    render(<SignInScreen services={testServices({ session: fakeSession(SIGNED_OUT) })} />);

    await userEvent.type(screen.getByLabelText(/email address/i), "user@example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a sign-in link/i }));

    expect(await screen.findByRole("heading", { level: 1, name: /check your email/i })).toBeTruthy();
  });

  it("reads a transport failure as offline, not as signed out", () => {
    const offline = {
      ...SIGNED_OUT,
      status: "unknown" as const,
      error: new AdapterError("no route", { code: "api-server", retryable: true }),
    };
    render(<SignInScreen services={testServices({ session: fakeSession(offline) })} />);

    // Asking someone to sign in is a dead end when signing in is the one thing
    // they cannot currently do.
    expect(screen.queryByLabelText(/email address/i)).toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });
});
