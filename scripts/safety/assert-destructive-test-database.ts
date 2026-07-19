/**
 * Hard guard for destructive database proofs.
 *
 * Born from a real local incident: a Gate-1 FK proof ran DELETEs against the
 * shared dev database after a fixture insert failed silently. Every
 * destructive integration script must call `assertDestructiveTestDatabase()`
 * first; it validates the EFFECTIVE DATABASE_URL (after all env-file loading,
 * which can silently override an exported value — see .env.test.example) and
 * refuses anything that is not a disposable local test database plus an
 * explicit typed confirmation.
 *
 * Error messages may name the host classification, database name and failed
 * condition — never the username, password or full URL.
 */

export const DESTRUCTIVE_CONFIRMATION = "I_UNDERSTAND_THIS_DELETES_FIXTURES";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "mysql"]);

export type DestructiveDbDecision =
  | { allowed: true; host: string; database: string }
  | { allowed: false; reason: string };

export function evaluateDestructiveTestDatabase(env: {
  APP_ENV?: string;
  DATABASE_URL?: string;
  ALLOW_DESTRUCTIVE_DB_TESTS?: string;
}): DestructiveDbDecision {
  const appEnv = env.APP_ENV?.trim();
  if (appEnv !== "test" && appEnv !== "local") {
    return {
      allowed: false,
      reason: `APP_ENV must be "test" or "local" (got "${appEnv ?? "unset"}")`,
    };
  }

  const rawUrl = env.DATABASE_URL?.trim().replace(/^"|"$/g, "");
  if (!rawUrl) {
    return { allowed: false, reason: "DATABASE_URL is unset" };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "DATABASE_URL is malformed" };
  }

  const host = url.hostname;
  if (!LOCAL_HOSTS.has(host)) {
    return {
      allowed: false,
      reason: `host "${host}" is not a repository-owned local database host`,
    };
  }

  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    return { allowed: false, reason: "DATABASE_URL has no database name" };
  }
  if (!/(_test|_scratch)$/.test(database)) {
    return {
      allowed: false,
      reason: `database "${database}" must end with _test or _scratch`,
    };
  }

  if (env.ALLOW_DESTRUCTIVE_DB_TESTS !== DESTRUCTIVE_CONFIRMATION) {
    return {
      allowed: false,
      reason: `ALLOW_DESTRUCTIVE_DB_TESTS must equal ${DESTRUCTIVE_CONFIRMATION}`,
    };
  }

  return { allowed: true, host, database };
}

/** Throws unless every destructive-test safety condition holds. */
export function assertDestructiveTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
): { host: string; database: string } {
  const decision = evaluateDestructiveTestDatabase({
    APP_ENV: env.APP_ENV,
    DATABASE_URL: env.DATABASE_URL,
    ALLOW_DESTRUCTIVE_DB_TESTS: env.ALLOW_DESTRUCTIVE_DB_TESTS,
  });

  if (!decision.allowed) {
    throw new Error(
      `Destructive database guard refused to run: ${decision.reason}`,
    );
  }

  return { host: decision.host, database: decision.database };
}
