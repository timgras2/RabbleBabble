import type { AudioRecording } from "../platform/audio/types";
import { AdapterError } from "../platform/errors";
import { fakeInference, fakeRecorder, fakeSettings, fakeStore } from "../test/services";
import { DictationFlowService } from "./dictationFlow";

function buffered(id: string): AudioRecording {
  return {
    id,
    blob: new Blob(["earlier audio"], { type: "audio/webm" }),
    mimeType: "audio/webm",
    durationMs: 0,
    endedBy: "interrupted",
  };
}

/**
 * The durability layer exists for one reason: a reload, a crash or a killed
 * tab used to take the recording with it, while the UI said nothing was lost.
 */
describe("buffered recordings", () => {
  it("offers an orphan from a previous session rather than transcribing it", async () => {
    const transcribe = vi.fn(async () => ({ text: "recovered words" }));
    const store = fakeStore([buffered("orphan")]);
    const flow = new DictationFlowService({
      recorder: fakeRecorder(),
      settings: fakeSettings({ cleanupEnabled: false }),
      inference: fakeInference({ transcribe }),
      store,
    });

    await flow.scanBuffer();

    expect(flow.getSnapshot().recoverable?.id).toBe("orphan");
    // Transcribing it unasked would spend quota on audio the user may have
    // abandoned on purpose.
    expect(transcribe).not.toHaveBeenCalled();

    await expect(flow.recoverBuffered()).resolves.toMatchObject({ finalText: "recovered words" });
    expect(flow.getSnapshot().recoverable).toBeNull();
    // Delivered, so the buffered copy is gone.
    expect(await store.listRecordings()).toHaveLength(0);
  });

  it("discards an orphan on request, without sending it anywhere", async () => {
    const transcribe = vi.fn();
    const store = fakeStore([buffered("unwanted")]);
    const flow = new DictationFlowService({
      recorder: fakeRecorder(),
      settings: fakeSettings({ cleanupEnabled: false }),
      inference: fakeInference({ transcribe }),
      store,
    });

    await flow.scanBuffer();
    await flow.discardBuffered();

    expect(await store.listRecordings()).toHaveLength(0);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("keeps the buffered copy when the upload fails", async () => {
    const recorder = fakeRecorder();
    const store = fakeStore([{ ...buffered("live"), endedBy: "user" }]);
    const flow = new DictationFlowService({
      recorder,
      settings: fakeSettings({ cleanupEnabled: false }),
      inference: fakeInference({
        transcribe: async () => {
          throw new AdapterError("offline", { code: "api-server", retryable: true });
        },
      }),
      store,
    });
    recorder.next = { ...recorder.next, id: "live" };

    await flow.start();
    await expect(flow.stop()).rejects.toMatchObject({ code: "api-server" });

    // Nothing came back, so nothing is deleted. This is the whole point.
    expect(await store.listRecordings()).toHaveLength(1);
  });

  it("writes a transcript to on-device history only when it is switched on", async () => {
    const store = fakeStore();
    const settings = fakeSettings({ cleanupEnabled: false, historyEnabled: false });
    const flow = new DictationFlowService({
      recorder: fakeRecorder(),
      settings,
      inference: fakeInference(),
      store,
    });

    await flow.start();
    await flow.stop();
    expect(await store.listTranscripts()).toHaveLength(0);

    settings.update({ historyEnabled: true });
    await flow.start();
    await flow.stop();
    await vi.waitUntil(async () => (await store.listTranscripts()).length === 1);
  });
});
