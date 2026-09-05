import { MAX_AUDIO_BYTES } from "../../../src/shared/limits";
import { invalidBody, payloadTooLarge } from "../errors";

const ALLOWED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/m4a",
  "audio/mpeg",
  "audio/wav",
  "audio/flac",
]);

export function isAllowedAudioType(mimeType: string): boolean {
  return ALLOWED_AUDIO_TYPES.has(mimeType);
}

export function audioFilename(mimeType: string): string {
  const extension = mimeType.includes("mp4") || mimeType.includes("m4a") ? "mp4" : "webm";
  return `rabblebabble-recording.${extension}`;
}

/**
 * Buffers the upload.
 *
 * This is the one place the Workers plan question actually lands. Buffering
 * costs CPU and memory but makes the 5xx retry free, because the bytes are
 * still in hand; a streamed body is consumed by the first attempt and cannot
 * be replayed. If the 24 MB CPU measurement says buffering does not fit the
 * free plan, this function is the seam to swap - streaming here means giving
 * up automatic retry and surfacing a Retry button instead, which is what
 * recommendations.md item 3 argued for anyway.
 */
export async function readAudioBody(request: Request): Promise<ArrayBuffer> {
  const declared = request.headers.get("Content-Length");
  if (declared === null) {
    throw invalidBody("That recording could not be read.", "recording-invalid");
  }

  const declaredBytes = Number(declared);
  if (!Number.isFinite(declaredBytes) || declaredBytes <= 0) {
    throw invalidBody("That recording could not be read.", "recording-invalid");
  }
  if (declaredBytes > MAX_AUDIO_BYTES) {
    throw payloadTooLarge("That recording is too long to upload.", "recording-too-large");
  }

  const audio = await request.arrayBuffer();
  // Checked again: a client that is not our own can lie about Content-Length.
  if (audio.byteLength === 0) {
    throw invalidBody("That recording was empty.", "recording-invalid");
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw payloadTooLarge("That recording is too long to upload.", "recording-too-large");
  }

  return audio;
}
