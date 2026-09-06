import { Hono } from "hono";
import { registerAuthRoutes } from "./auth/routes";
import type { SessionUser } from "./auth/session";
import type { Deps } from "./deps";
import { ApiError, internalError, toErrorBody } from "./errors";
import { applySecurityHeaders } from "./http/security";
import { registerV1Routes } from "./v1/routes";

type Vars = {
  deps: Deps;
  requestId: string;
  session?: SessionUser;
};

export type App = Hono<{ Bindings: Env; Variables: Vars }>;

/**
 * Built from injected deps rather than reading `env`, so tests drive the real
 * routing and the real database with a stubbed Groq fetcher and mailer.
 */
/**
 * Turns whatever was thrown into something a log line can carry.
 *
 * `String(value)` on a plain object produces "[object Object]" -- for exactly
 * the failure you most want to debug, since that is what an upstream error
 * body deserialises to.
 */
function describe(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserialisable]";
    }
  }
  return String(value);
}

export function createApp(deps: Deps): App {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("deps", deps);
    c.set("requestId", requestId);

    const startedAt = Date.now();
    await next();

    // Structured, and content-free by construction: ids, status, latency.
    // Never a transcript, an instruction, an email address or a token.
    console.log(
      JSON.stringify({
        requestId,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
        userId: c.get("session")?.id ?? null,
      }),
    );

    c.res = applySecurityHeaders(c.res, requestId);
  });

  registerAuthRoutes(app);
  registerV1Routes(app);

  app.notFound((c) =>
    c.json(
      toErrorBody(
        new ApiError({
          status: 404,
          code: "api-invalid",
          reason: "invalid-body",
          message: "Unknown endpoint.",
        }),
        c.get("requestId"),
      ),
      404,
    ),
  );

  app.onError((error, c) => {
    const requestId = c.get("requestId");
    if (error instanceof ApiError) {
      if (error.internal !== undefined) {
        console.error(JSON.stringify({ requestId, reason: error.reason, internal: describe(error.internal) }));
      }
      const headers: Record<string, string> = {};
      if (error.retryAfterSeconds !== undefined) {
        headers["Retry-After"] = String(error.retryAfterSeconds);
      }
      return c.json(toErrorBody(error, requestId), error.status as 400, headers);
    }

    // An unexpected throw must not leak a stack trace to the browser.
    console.error(JSON.stringify({ requestId, unexpected: String(error) }));
    return c.json(toErrorBody(internalError(error), requestId), 500);
  });

  return app;
}
