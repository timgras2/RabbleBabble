import { createApp } from "./app";
import { buildDeps } from "./deps";
import { runSweep } from "./db/sweep";

// A thin adapter over createApp so the app can be built with stubbed deps in
// tests while production still goes through the real entrypoint.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return createApp(buildDeps(env)).fetch(request, env, ctx);
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runSweep(env.DB, Math.floor(Date.now() / 1000)));
  },
} satisfies ExportedHandler<Env>;
