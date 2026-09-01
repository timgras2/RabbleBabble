export type ClipboardStatus = "copied" | "empty" | "unavailable" | "denied";

export interface ClipboardResult {
  readonly status: ClipboardStatus;
  readonly message?: string;
}

export interface ClipboardAdapter {
  writeText(text: string): Promise<ClipboardResult>;
}
