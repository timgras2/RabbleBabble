import { readConfig, type Config } from "./config";
import { ConsoleEmailSender } from "./email/console";
import { ResendEmailSender } from "./email/resend";
import type { EmailSender } from "./email/port";
import { GroqGateway } from "./groq/gateway";
import { systemClock, type Clock } from "./usage/clock";

export interface Deps {
  readonly config: Config;
  readonly db: D1Database;
  readonly clock: Clock;
  readonly email: EmailSender;
  readonly groq: GroqGateway;
}

/**
 * The composition root. Tests build Deps directly with a stubbed Groq fetcher
 * and an in-memory mailer, which is why routes never reach for `env`.
 */
export function buildDeps(env: Env): Deps {
  const config = readConfig(env);

  return {
    config,
    db: env.DB,
    clock: systemClock,
    email:
      config.emailMode === "resend"
        ? new ResendEmailSender(config.resendApiKey, config.emailFrom)
        : new ConsoleEmailSender(),
    groq: new GroqGateway({ baseUrl: config.groqBaseUrl, apiKey: config.groqApiKey }),
  };
}
