import { createApp } from "./app";
import { ConfigError } from "./config";
import { buildDeps } from "./deps";
import { runSweep } from "./db/sweep";

// A thin adapter over createApp so the app can be built with stubbed deps in
// tests while production still goes through the real entrypoint.
/**
 * Built once per isolate.
 *
 * readConfig runs ~18 validations and buildDeps allocates a gateway and a
 * mailer; doing that per request was pure overhead on every single call. The
 * env of an isolate never changes, so one memo is correct -- but it is keyed
 * on the env object anyway, so a test or a preview that swaps it is not served
 * a stale app.
 */
let cached: { env: Env; app: ReturnType<typeof createApp> } | null = null;

function appFor(env: Env): ReturnType<typeof createApp> {
  if (cached === null || cached.env !== env) {
    cached = { env, app: createApp(buildDeps(env)) };
  }
  return cached.app;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    let app;
    try {
      app = appFor(env);
    } catch (error) {
      // Config is read before Hono exists, so a missing secret would otherwise
      // escape as Cloudflare's opaque "Worker threw an exception" page. Say
      // what is actually wrong instead - in the logs, where it belongs.
      const detail = error instanceof ConfigError ? error.message : "Worker failed to start";
      console.error(`[startup] ${detail}`);
      return Response.json(
        {
          error: {
            code: "api-server",
            reason: "internal",
            message: "RabbleBabble is not configured correctly.",
            retryable: false,
            requestId: crypto.randomUUID(),
          },
        },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }

    return app.fetch(request, env, ctx);
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runSweep(env.DB, Math.floor(Date.now() / 1000)));
  },
} satisfies ExportedHandler<Env>;
