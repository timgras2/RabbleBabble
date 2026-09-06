import { fireEvent, render, screen } from "@testing-library/react";
import { MediaRecorderAdapter } from "../platform/audio/MediaRecorderAdapter";
import { DictationFlowService } from "../services/dictationFlow";
import { fakeClipboard, fakeInference, fakeSession, fakeSettings } from "../test/services";
import type { AppServices } from "../app/types";
import { RecorderScreen } from "./RecorderScreen";

class StubMediaRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

/**
 * Boundary rule 11, made enforceable.
 *
 * WebKit gates the microphone prompt on a live user activation, and activation
 * does not survive an await. Every other platform forgives this, which is why
 * three awaits accumulated between the tap and getUserMedia and the symptom
 * came back as "iOS blocks the microphone by default".
 *
 * The assertion needs no Safari: getUserMedia must already have been called
 * when the click handler returns, with nothing awaited in between.
 */
describe("record tap", () => {
  it("reaches getUserMedia with no awaited promise in between", () => {
    const getUserMedia = vi.fn(
      async () => ({ getTracks: () => [], getAudioTracks: () => [] }) as unknown as MediaStream,
    );
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", StubMediaRecorder);

    const recorder = new MediaRecorderAdapter();
    const settings = fakeSettings({ cleanupEnabled: false });
    const inference = fakeInference();
    const services: AppServices = {
      recorder,
      settings,
      inference,
      session: fakeSession(),
      clipboard: fakeClipboard(),
      dictation: new DictationFlowService({ recorder, settings, inference }),
    };

    render(
      <RecorderScreen services={services} onOpenSettings={() => undefined} onSignIn={() => undefined} />,
    );

    // Deliberately not `await userEvent.click`: awaiting here would hide the
    // very thing under test by letting microtasks drain first.
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
