import { invalidBody, payloadTooLarge } from "../errors";

/**
 * Reads a JSON body with a hard size cap.
 *
 * Content-Length is checked first so an oversized body is refused before it is
 * buffered, and the actual length is checked afterwards because a non-browser
 * client can lie about the header.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.split(";")[0]?.trim().toLowerCase().startsWith("application/json")) {
    throw invalidBody("Expected a JSON body.");
  }

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw payloadTooLarge("That is too much text to send at once.", "rewrite-too-large");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw payloadTooLarge("That is too much text to send at once.", "rewrite-too-large");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidBody("That request body was not valid JSON.");
  }
}

export function readString(payload: unknown, field: string): string {
  if (typeof payload !== "object" || payload === null) {
    throw invalidBody("That request body was not valid JSON.");
  }
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== "string") {
    throw invalidBody(`Expected "${field}" to be text.`);
  }
  return value;
}

export function readOptionalString(payload: unknown, field: string): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}
