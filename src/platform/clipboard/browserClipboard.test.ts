import { BrowserClipboard } from "./browserClipboard";

describe("BrowserClipboard", () => {
  it("copies through the modern API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await expect(new BrowserClipboard().writeText("hello")).resolves.toEqual({ status: "copied" });
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("uses the textarea fallback when the modern API is absent", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => true) });

    await expect(new BrowserClipboard().writeText("hello")).resolves.toEqual({ status: "copied" });
  });

  it("reports empty input without touching the clipboard", async () => {
    await expect(new BrowserClipboard().writeText("  ")).resolves.toEqual({
      status: "empty",
      message: "There is no text to copy.",
    });
  });

  it("reports a denied modern clipboard gesture", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }) },
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });

    await expect(new BrowserClipboard().writeText("hello")).resolves.toMatchObject({ status: "denied" });
  });
});
