const DEFAULT_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

export function negotiateMimeType(preferred?: readonly string[]): string {
  const candidates = preferred ?? DEFAULT_MIME_TYPES;
  const isSupported =
    typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.isTypeSupported === "function";

  if (!isSupported) {
    return "";
  }

  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}
