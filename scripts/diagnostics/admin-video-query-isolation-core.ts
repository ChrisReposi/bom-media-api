import {
  readDatabaseStage,
  toSafeDatabaseErrorContext,
  type SafeDatabaseErrorContext,
} from "../../src/common/errors/safe-database-error-context.util";

export const PRODUCTION_DIAGNOSTIC_CONFIRMATION =
  "I_UNDERSTAND_THIS_ONLY_READS_PRODUCTION_DATA";

export type AdminVideoDiagnosticOptions = {
  isProduction: boolean;
  websiteId: string | null;
  search: string;
  includeConcurrencyComparison: boolean;
};

export type SafeDiagnosticFailure = {
  status: "FAIL";
  error: SafeDatabaseErrorContext;
  stage?: string;
  sourceLocation?: string;
};

function safeSourceLocation(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") {
    return undefined;
  }
  const match = error.stack.match(
    /(?:src|scripts)\/[a-zA-Z0-9_./-]+\.ts:\d+:\d+/,
  );
  return match?.[0];
}

export function readAdminVideoDiagnosticOptions(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): AdminVideoDiagnosticOptions {
  const isProduction =
    env.NODE_ENV === "production" || env.APP_ENV === "production";
  const websiteId = env.ADMIN_VIDEO_DIAGNOSTIC_WEBSITE_ID?.trim() || null;
  const search = env.ADMIN_VIDEO_DIAGNOSTIC_SEARCH?.trim() || "sml";
  const includeConcurrencyComparison = argv.includes("--include-concurrency");

  if (search.length < 2 || search.length > 80) {
    throw new Error("Diagnostic search length must be between 2 and 80.");
  }
  if (websiteId !== null && websiteId.length > 191) {
    throw new Error("Diagnostic website identifier is too long.");
  }
  if (isProduction) {
    if (
      env.ALLOW_READ_ONLY_PRODUCTION_DIAGNOSTICS !==
      PRODUCTION_DIAGNOSTIC_CONFIRMATION
    ) {
      throw new Error("Production read-only diagnostic confirmation missing.");
    }
    if (websiteId === null) {
      throw new Error("Production diagnostic requires an explicit website.");
    }
    if (includeConcurrencyComparison) {
      throw new Error(
        "Concurrency comparison is prohibited against Production.",
      );
    }
  }

  return {
    isProduction,
    websiteId,
    search,
    includeConcurrencyComparison,
  };
}

export function toSafeDiagnosticFailure(error: unknown): SafeDiagnosticFailure {
  const stage = readDatabaseStage(error);
  const sourceLocation = safeSourceLocation(error);
  return {
    status: "FAIL",
    error: toSafeDatabaseErrorContext(error),
    ...(stage ? { stage } : {}),
    ...(sourceLocation ? { sourceLocation } : {}),
  };
}
