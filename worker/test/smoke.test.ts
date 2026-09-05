import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { buildDeps } from "../src/deps";

describe("worker scaffolding", () => {
  it("answers an unknown endpoint with the shared error envelope", async () => {
    const app = createApp(buildDeps(env));
    const response = await app.request("/v1/nope", { method: "GET" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "api-invalid" } });
  });

  it("has every table from the initial migration", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = results.map((row) => row.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "auth_rate_limits",
        "auth_tokens",
        "invite_codes",
        "reservations",
        "sessions",
        "spend_daily",
        "usage_daily",
        "users",
      ]),
    );
  });
});
