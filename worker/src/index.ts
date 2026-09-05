import { createApp } from "./app";

// A thin adapter over createApp so the app can be built with stubbed deps in
// tests while production still goes through the real entrypoint.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return createApp({ env }).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
