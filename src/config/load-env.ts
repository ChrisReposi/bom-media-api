import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

const LOCAL_LIFECYCLE_EVENTS = new Set([
  "dev:local",
  "start:local",
  "db:generate",
  "db:validate",
  "db:migrate:dev",
  "db:migrate:status",
  "db:seed",
  "db:reset",
  "db:studio",
  "db:local:generate",
  "db:local:validate",
  "db:local:migrate",
  "db:local:deploy",
  "db:local:status",
  "db:local:seed",
  "db:local:reset",
  "db:local:studio",
]);

function shouldLoadLocalEnv(): boolean {
  if (process.env.APP_ENV === "local") {
    return true;
  }

  if (
    process.env.NODE_ENV === "production" ||
    process.env.APP_ENV === "production"
  ) {
    return false;
  }

  const lifecycleEvent = process.env.npm_lifecycle_event;

  return (
    lifecycleEvent !== undefined && LOCAL_LIFECYCLE_EVENTS.has(lifecycleEvent)
  );
}

export function loadApiEnv(): void {
  const root = process.cwd();
  const fallbackEnvPath = resolve(root, ".env");
  const explicitEnvPath = process.env.DOTENV_CONFIG_PATH?.trim();

  if (existsSync(fallbackEnvPath)) {
    loadDotenv({
      path: fallbackEnvPath,
      override: false,
      quiet: true,
    });
  }

  if (explicitEnvPath !== undefined && explicitEnvPath !== "") {
    const resolvedExplicitEnvPath = resolve(root, explicitEnvPath);
    if (!existsSync(resolvedExplicitEnvPath)) {
      throw new Error(
        `DOTENV_CONFIG_PATH points to a missing file: ${explicitEnvPath}`,
      );
    }

    loadDotenv({
      path: resolvedExplicitEnvPath,
      override: true,
      quiet: true,
    });
    return;
  }

  const localEnvPath = resolve(root, ".env.local");
  if (shouldLoadLocalEnv()) {
    if (!existsSync(localEnvPath)) {
      throw new Error(
        "Local commands require .env.local. Copy .env.local.example to .env.local first.",
      );
    }

    loadDotenv({
      path: localEnvPath,
      override: true,
      quiet: true,
    });
  }
}
