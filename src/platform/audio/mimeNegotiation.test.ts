import { negotiateMimeType } from "./mimeNegotiation";

describe("negotiateMimeType", () => {
  it("selects the first supported Android-friendly type", () => {
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: vi.fn((type: string) => type === "audio/mp4"),
    });

    expect(negotiateMimeType()).toBe("audio/mp4");
  });

  it("returns the browser default when no candidate is supported", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });

    expect(negotiateMimeType()).toBe("");
  });
});
