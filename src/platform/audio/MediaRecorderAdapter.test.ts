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

function installMedia(stream: MediaStream) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
}

describe("MediaRecorderAdapter", () => {
  it("records native audio and releases tracks and wake lock", async () => {
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
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

  it("rejects recordings over the configured byte limit", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    installMedia(stream);
    const adapter = new MediaRecorderAdapter({ maxBytes: 1 });
    await adapter.start();

    await expect(adapter.stop()).rejects.toMatchObject({ code: "recording-too-large" });
    expect(adapter.state).toBe("idle");
  });

  it("auto-stops at the duration limit and reports it on stop", async () => {
    vi.useFakeTimers();
    try {
      const stream = { getTracks: () => [] } as unknown as MediaStream;
      installMedia(stream);
      const adapter = new MediaRecorderAdapter({ maxDurationMs: 100 });
      await adapter.start();
      vi.advanceTimersByTime(101);

      await expect(adapter.stop()).rejects.toMatchObject({ code: "recording-too-long" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when a timeslice pushes the recording over the byte limit", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    installMedia(stream);
    const adapter = new MediaRecorderAdapter({ maxBytes: 1 });

    await adapter.start();
    FakeMediaRecorder.lastInstance?.emitData(new Blob(["oversized chunk"]));

    await expect(adapter.stop()).rejects.toMatchObject({ code: "recording-too-large" });
  });
});
