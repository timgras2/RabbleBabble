import type { ClipboardAdapter, ClipboardResult } from "./types";

export class BrowserClipboard implements ClipboardAdapter {
  async writeText(text: string): Promise<ClipboardResult> {
    if (!text.trim()) {
      return { status: "empty", message: "There is no text to copy." };
    }

    let modernDenied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return { status: "copied" };
      } catch (error) {
        modernDenied = error instanceof DOMException && error.name === "NotAllowedError";
      }
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (copied) {
        return { status: "copied" };
      }
    } catch {
      // Map the expected browser failure below.
    }

    return modernDenied
      ? { status: "denied", message: "Clipboard permission was denied." }
      : { status: "unavailable", message: "Clipboard is unavailable on this device." };
  }
}
