import { Hono } from "hono";

export interface Deps {
  readonly env: Env;
}

type Vars = { readonly deps: Deps };

export type App = Hono<{ Bindings: Env; Variables: Vars }>;

/**
 * Built from injected deps rather than reading `env` directly, so tests can
 * drive the real routing with a stubbed Groq fetcher and a stubbed mailer.
 */
export function createApp(deps: Deps): App {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.all("*", (c) => c.json({ error: { code: "api-invalid", message: "Unknown endpoint." } }, 404));

  return app;
}
