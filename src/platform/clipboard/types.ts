export type ClipboardStatus = "copied" | "empty" | "unavailable" | "denied";

export interface ClipboardResult {
  readonly status: ClipboardStatus;
  readonly message?: string;
}

export interface ClipboardAdapter {
  writeText(text: string): Promise<ClipboardResult>;

  /** False where navigator.share is missing, so the UI can simply not offer it. */
  canShare(): boolean;

  /**
   * Hands the text to the system share sheet. Reuses ClipboardResult for
   * symmetry: same statuses, same handling at the call site. A share the user
   * dismisses reports "empty" rather than an error -- cancelling is not a
   * failure.
   */
  shareText(text: string): Promise<ClipboardResult>;
}
