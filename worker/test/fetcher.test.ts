import { describe, expect, it } from "vitest";
import { defaultFetch } from "../src/http/fetcher";

const UNREACHABLE = "http://127.0.0.1:1/";

async function failureFrom(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "";
  } catch (error) {
    return String(error);
  }
}

describe("defaultFetch", () => {
  /**
   * The hazard this helper exists for. Storing bare `fetch` on an object and
   * calling it as a method detaches it from globalThis, and workerd refuses.
   * Every other test injects its own fetcher, so nothing else can catch this -
   * it took a real deployment and a live recording to find it the first time.
   */
  it("shows that an unbound global fetch really does break when called as a method", async () => {
    const holder = { fetcher: globalThis.fetch };

    const failure = await failureFrom(() => holder.fetcher(UNREACHABLE));

    expect(failure).toContain("Illegal invocation");
  });

  it("survives being called as a method on an object", async () => {
    const holder = { fetcher: defaultFetch() };

    const failure = await failureFrom(() => holder.fetcher(UNREACHABLE));

    // It still fails - nothing is listening - but for the right reason.
    expect(failure).not.toContain("Illegal invocation");
  });
});
