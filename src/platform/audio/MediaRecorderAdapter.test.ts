import { MediaRecorderAdapter } from "./MediaRecorderAdapter";

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  static lastInstance: FakeMediaRecorder | null = null;
  state: RecordingState = "inactive";
  mimeType = "audio/webm;codecs=opus";
  startTimeslice: number | undefined;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? this.mimeType;
    FakeMediaRecorder.lastInstance = this;
  }

  start(timeslice?: number) {
    this.startTimeslice = timeslice;
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["recorded audio"], { type: this.mimeType }) });
    this.onstop?.();
  }

  emitData(data: Blob) {
    this.ondataavailable?.({ data });
  }
}

type RecordingState = "inactive" | "recording";

function audioTrack(): MediaStreamTrack {
  return {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function streamOf(tracks: MediaStreamTrack[]): MediaStream {
  return { getTracks: () => tracks, getAudioTracks: () => tracks } as unknown as MediaStream;
}

function installMedia(stream: MediaStream) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
}

describe("MediaRecorderAdapter", () => {
  it("records native audio and releases tracks and wake lock", async () => {
    const track = audioTrack();
    const stream = streamOf([track]);
    const release = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: vi.fn(async () => ({ released: false, release })) },
    });
    installMedia(stream);
    const adapter = new MediaRecorderAdapter();
    const states: string[] = [];
    adapter.subscribe((state) => states.push(state));

    await adapter.start();
    const recording = await adapter.stop();

    expect(FakeMediaRecorder.lastInstance?.startTimeslice).toBe(10_000);
    expect(recording.mimeType).toContain("webm");
    expect(recording.blob.size).toBeGreaterThan(0);
    expect(recording.endedBy).toBe("user");
    expect(states).toEqual(["recording", "stopping", "idle"]);
    expect(track.stop).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("maps microphone permission failures", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }) },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const adapter = new MediaRecorderAdapter();

    await expect(adapter.start()).rejects.toMatchObject({ code: "mic-denied" });
  });

  it("maps a missing microphone to an unavailable error", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new DOMException("missing", "NotFoundError"); }) },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const adapter = new MediaRecorderAdapter();

    await expect(adapter.start()).rejects.toMatchObject({ code: "mic-unavailable" });
  });

  /**
   * The adapter no longer destroys an oversized recording. It hands it back
   * labelled, and the delivery layer -- which is the one that knows the upload
   * limit -- is what refuses it. Losing the bytes here helped nobody.
   */
  it("returns an over-limit recording labelled rather than discarding it", async () => {
    installMedia(streamOf([audioTrack()]));
    const adapter = new MediaRecorderAdapter({ maxBytes: 1 });
    await adapter.start();

    await expect(adapter.stop()).resolves.toMatchObject({ endedBy: "byte-limit" });
    expect(adapter.state).toBe("idle");
  });

  /**
   * The old version of this test called stop() immediately, so it never saw the
   * window the bug lived in: the adapter had released the microphone and thrown
   * the audio away while still reporting "recording", and the UI counted a
   * timer past the cap into a dead stream.
   */
  it("publishes the auto-stop and keeps the audio, with no stop() call at all", async () => {
    vi.useFakeTimers();
    try {
      const stream = streamOf([audioTrack()]);
      installMedia(stream);
      const adapter = new MediaRecorderAdapter({ maxDurationMs: 100 });
      const states: string[] = [];
      adapter.subscribe((state) => states.push(state));

      await adapter.start();
      vi.advanceTimersByTime(101);

      // Nobody asked. Subscribers were told anyway.
      expect(adapter.state).toBe("auto-stopped");
      expect(states).toEqual(["recording", "auto-stopped"]);

      // And the words survived.
      const recording = await adapter.stop();
      expect(recording.blob.size).toBeGreaterThan(0);
      expect(recording.endedBy).toBe("duration-limit");
      expect(adapter.state).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the audio when a timeslice pushes it over the byte limit", async () => {
    installMedia(streamOf([audioTrack()]));
    const adapter = new MediaRecorderAdapter({ maxBytes: 1 });

    await adapter.start();
    FakeMediaRecorder.lastInstance?.emitData(new Blob(["oversized chunk"]));

    expect(adapter.state).toBe("auto-stopped");
    const recording = await adapter.stop();
    expect(recording.endedBy).toBe("byte-limit");
    expect(recording.blob.size).toBeGreaterThan(0);
  });

  it("ends the recording when something else takes the microphone", async () => {
    const listeners = new Map<string, () => void>();
    const track = {
      stop: vi.fn(),
      addEventListener: (name: string, handler: () => void) => listeners.set(name, handler),
      removeEventListener: () => undefined,
    } as unknown as MediaStreamTrack;
    installMedia(streamOf([track]));
    const adapter = new MediaRecorderAdapter();

    await adapter.start();
    listeners.get("ended")?.();

    expect(adapter.state).toBe("auto-stopped");
    await expect(adapter.stop()).resolves.toMatchObject({ endedBy: "interrupted" });
  });

  it("cancel discards a recording the adapter ended by itself", async () => {
    vi.useFakeTimers();
    try {
      installMedia(streamOf([audioTrack()]));
      const adapter = new MediaRecorderAdapter({ maxDurationMs: 100 });
      await adapter.start();
      vi.advanceTimersByTime(101);

      await adapter.cancel();

      expect(adapter.state).toBe("idle");
      await expect(adapter.stop()).rejects.toMatchObject({ code: "recording-invalid" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes the recorder's own start time, so the elapsed timer cannot reset", async () => {
    installMedia(streamOf([audioTrack()]));
    const adapter = new MediaRecorderAdapter();

    expect(adapter.startedAt).toBeNull();
    await adapter.start();
    expect(adapter.startedAt).toBeGreaterThan(0);
  });
});
