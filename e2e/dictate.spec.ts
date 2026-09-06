import { expect, test } from "@playwright/test";

/**
 * tap -> speak -> tap -> text, against the built bundle.
 *
 * docs/v2-plan.md called this "the single highest-value test you can add", and
 * it is: it is the only check that runs the real build, the real bundling, the
 * real service-worker registration and the real CSP together. Everything else
 * in the suite runs modules in isolation, where all four of those are absent.
 *
 * The microphone and the network are the two things a headless browser cannot
 * honestly provide, so both are faked at the platform boundary rather than by
 * reaching into the app: MediaRecorder and getUserMedia are replaced before
 * any app code runs, and Groq is intercepted at the HTTP layer.
 */
const MOCK_TRANSCRIPT = "the quick brown fox jumped over the lazy dog";
const MOCK_CLEANED = "The quick brown fox jumped over the lazy dog.";

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  // A bring-your-own-key build needs a key before it will record at all.
  await page.addInitScript(() => {
    localStorage.setItem(
      "rabblebabble.settings",
      JSON.stringify({ groqApiKey: "gsk_e2e_test_key", cleanupEnabled: true, language: "" }),
    );
  });

  // Stand in for a microphone. Installed as an init script so it is in place
  // before the bundle evaluates, exactly as a real API would be.
  await page.addInitScript(() => {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      state = "inactive";
      mimeType = "audio/webm;codecs=opus";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["e2e audio"], { type: this.mimeType }) });
        this.onstop?.();
      }
    }

    const track = { kind: "audio", stop() {}, addEventListener() {}, removeEventListener() {} };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(stream) },
    });
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
  });

  await page.route("https://api.groq.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/audio/transcriptions")) {
      await route.fulfill({ json: { text: MOCK_TRANSCRIPT } });
      return;
    }
    await route.fulfill({ json: { choices: [{ message: { content: MOCK_CLEANED } }] } });
  });
});

test("records, transcribes and copies", async ({ page }) => {
  await page.goto("/");

  const record = page.getByRole("button", { name: /start recording/i });
  await expect(record).toBeVisible();
  await record.click();

  await expect(page.getByRole("button", { name: /stop recording/i })).toBeVisible();
  await page.getByRole("button", { name: /stop recording/i }).click();

  // Cleanup ran, so this is the polished text and not the raw transcript.
  await expect(page.getByText(MOCK_CLEANED)).toBeVisible();

  await page.getByRole("button", { name: /copy text/i }).click();
  await expect(page.getByRole("button", { name: /copied/i })).toBeVisible();

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(MOCK_CLEANED);
});

test("keeps the words when the upload fails, and sends them again on request", async ({ page }) => {
  // Flipped by the test, not counted: the adapter retries a 5xx by itself, so
  // "fail the first attempt" would simply succeed on the second and never
  // reach the state this test is about.
  let failing = true;
  await page.route("https://api.groq.com/openai/v1/audio/transcriptions", async (route) => {
    if (failing) {
      await route.fulfill({ status: 503, body: "upstream down" });
      return;
    }
    await route.fulfill({ json: { text: MOCK_TRANSCRIPT } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /start recording/i }).click();
  await page.getByRole("button", { name: /stop recording/i }).click();

  const retry = page.getByRole("button", { name: /try again/i });
  await expect(retry).toBeVisible();

  failing = false;
  await retry.click();

  // The product's whole promise, in one assertion: a failed upload does not
  // cost the user their words, and recovering them takes one tap.
  await expect(page.getByText(MOCK_CLEANED)).toBeVisible();
});
