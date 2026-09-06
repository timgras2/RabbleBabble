import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdapterError } from "../platform/errors";
import { fakeInference, fakeRecorder, testServices } from "../test/services";
import { RecorderScreen } from "./RecorderScreen";

/**
 * Every bug in Phase 0 of the V3 plan lived in this layer, which had no tests
 * at all. Each case here fails against the code as it shipped.
 */
function renderRecorder(services = testServices()) {
  const view = render(
    <RecorderScreen services={services} onOpenSettings={() => undefined} onSignIn={() => undefined} />,
  );
  return { services, view };
}

describe("RecorderScreen", () => {
  it("stops claiming to record when the recorder hits its own limit", async () => {
    const recorder = fakeRecorder();
    recorder.next = { ...recorder.next, endedBy: "duration-limit" };
    const { services } = renderRecorder(testServices({ recorder }));

    await userEvent.click(screen.getByRole("button", { name: /start recording/i }));
    // Announced and shown; the assertion is that it is claimed at all.
    expect(screen.getAllByText(/listening/i).length).toBeGreaterThan(0);

    // The adapter ended itself. Nothing called stop().
    await act(async () => {
      recorder.emit("auto-stopped");
    });

    await waitFor(() => expect(screen.queryAllByText(/listening/i)).toHaveLength(0));
    expect(screen.getAllByText(/five-minute limit/i).length).toBeGreaterThan(0);
    expect(services.dictation.getSnapshot().result?.finalText).toBe("hello world");
  });

  it("offers a retry that reuses the recording after a failed upload", async () => {
    const transcribe = vi.fn<() => Promise<{ text: string }>>()
      .mockRejectedValueOnce(new AdapterError("offline", { code: "api-server", retryable: true }))
      .mockResolvedValueOnce({ text: "second try" });
    renderRecorder(testServices({ inference: fakeInference({ transcribe }) }));

    await userEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await userEvent.click(screen.getByRole("button", { name: /stop recording/i }));

    const retry = await screen.findByRole("button", { name: /try again/i });
    await userEvent.click(retry);

    expect(await screen.findByText("second try")).toBeTruthy();
    // The user never re-recorded: the same bytes went up twice.
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("keeps the error text when the screen is unmounted and shown again", async () => {
    const services = testServices({
      inference: fakeInference({
        transcribe: async () => {
          throw new AdapterError("boom", { code: "api-timeout", retryable: true });
        },
      }),
    });
    const { view } = renderRecorder(services);

    await userEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await userEvent.click(screen.getByRole("button", { name: /stop recording/i }));
    await waitFor(() => expect(screen.getAllByText(/timed out/i).length).toBeGreaterThan(0));

    // What opening Settings and coming back does.
    view.unmount();
    render(<RecorderScreen services={services} onOpenSettings={() => undefined} onSignIn={() => undefined} />);

    // The old code kept the error STATE in the service and the error TEXT in
    // component state, so this said "Something needs your attention" with
    // nothing anywhere saying what.
    expect(screen.getAllByText(/timed out/i).length).toBeGreaterThan(0);
  });

  it("counts the elapsed timer from the recorder, not from its own mount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const recorder = fakeRecorder();
      const services = testServices({ recorder });
      const { view } = renderRecorder(services);

      await userEvent.click(screen.getByRole("button", { name: /start recording/i }));
      await act(async () => {
        vi.advanceTimersByTime(65_000);
      });
      expect(screen.getByText("01:05")).toBeTruthy();

      view.unmount();
      render(<RecorderScreen services={services} onOpenSettings={() => undefined} onSignIn={() => undefined} />);
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // Not 00:00. The recording is still a minute old and the cap is real.
      expect(screen.getByText("01:05")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
