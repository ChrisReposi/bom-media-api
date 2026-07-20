import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  MARIADB_COLLATION_PROBE_CONFIRMATION,
  MARIADB_COLLATION_PROBE_DISABLED,
  MARIADB_COLLATION_PROBE_EVENT,
} from "../src/common/diagnostics/mariadb-collation-probe.constants";
import { launchMariaDbCollationProbeAfterListen } from "../src/common/diagnostics/launch-mariadb-collation-probe";
import {
  MariaDbCollationProbeService,
  type MariaDbCollationProbeResult,
} from "../src/common/diagnostics/mariadb-collation-probe.service";
import { parseMariaDbCollationConflict } from "../src/common/errors/parse-mariadb-collation-conflict.util";
import { apiConfig } from "../src/config/env.config";
import { validateEnv } from "../src/config/env.validation";

const productionEnv = {
  NODE_ENV: "production",
  APP_ENV: "production",
  ADMIN_WEB_ORIGIN: "https://admin.example.com",
  DATABASE_URL: "mysql://test:test@127.0.0.1:3306/test_db",
  JWT_ACCESS_SECRET: "test-jwt-secret",
  REFRESH_TOKEN_PEPPER: "test-refresh-pepper",
  SHARE_TOKEN_PEPPER: "test-share-pepper",
  PUBLIC_MEDIA_GRANT_SECRET: "test-public-media-grant-secret-at-least-32-bytes",
  ACCESS_LOG_IP_PEPPER: "test-ip-pepper",
  ADMIN_CHANGE_PASSWORD_SECRET: "test-password-change-secret",
  VIDEO_DB_STORAGE_ENABLED: "false",
} as const;

const SESSION_ROW = {
  characterSetClient: "utf8mb4",
  characterSetConnection: "utf8mb4",
  collationConnection: "utf8mb4_unicode_ci",
  characterSetResults: "utf8mb4",
  characterSetServer: "utf8mb4",
  collationServer: "utf8mb4_unicode_ci",
  collationDatabase: "utf8mb4_unicode_ci",
  characterSetCollations: "utf8mb4=utf8mb4_uca1400_ai_ci",
};

const PARAMETER_ROW = {
  paramCharset: "utf8mb4",
  paramCollation: "utf8mb4_uca1400_ai_ci",
  paramCoercibility: 6n,
  literalCharset: "utf8mb4",
  literalCollation: "utf8mb4_unicode_ci",
  literalCoercibility: "6",
};

const CONCAT_ROW = {
  concatCharset: "utf8mb4",
  concatCollation: "utf8mb4_uca1400_ai_ci",
  concatCoercibility: 6,
};

class FakeProbeLogger {
  readonly events: MariaDbCollationProbeResult[] = [];
  context: string | undefined;

  setContext(context: string): void {
    this.context = context;
  }

  info(result: MariaDbCollationProbeResult): void {
    this.events.push(result);
  }
}

class FakeProbePrisma {
  readonly calls: Array<{ values: unknown[] }> = [];
  private readonly responses: Array<unknown[] | Error | Promise<unknown[]>>;

  constructor(
    responses: Array<unknown[] | Error | Promise<unknown[]>> = [
      [SESSION_ROW],
      [PARAMETER_ROW],
      [CONCAT_ROW],
    ],
  ) {
    this.responses = responses;
  }

  async $queryRaw(
    _query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> {
    this.calls.push({ values });
    const response = this.responses[this.calls.length - 1];
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error("Unexpected fake query.");
    }
    return await response;
  }
}

function createService(params?: {
  enabled?: boolean;
  prisma?: FakeProbePrisma;
  logger?: FakeProbeLogger;
}): {
  service: MariaDbCollationProbeService;
  prisma: FakeProbePrisma;
  logger: FakeProbeLogger;
} {
  const prisma = params?.prisma ?? new FakeProbePrisma();
  const logger = params?.logger ?? new FakeProbeLogger();
  const config = {
    getOrThrow: () => ({
      diagnostics: {
        mariaDbCollationProbeEnabled: params?.enabled ?? true,
      },
    }),
  };
  return {
    service: new MariaDbCollationProbeService(
      prisma as never,
      config as never,
      logger as never,
    ),
    prisma,
    logger,
  };
}

function driver1267(message: unknown): Error {
  return Object.assign(new Error("wrapper"), {
    name: "DriverAdapterError",
    cause: {
      kind: "mysql",
      originalCode: "1267",
      code: 1267,
      state: "HY000",
      originalMessage: message,
      sql: "SELECT private_value",
      parameters: ["diagnostic"],
      host: "private-host",
      database: "private-database",
      user: "private-user",
      password: "private-password",
    },
  });
}

describe("MariaDB collation probe environment guard", () => {
  it("defaults disabled, accepts only the exact confirmation, and rejects malformed values", () => {
    const previousEnv = { ...process.env };
    try {
      const disabled = validateEnv(productionEnv);
      assert.equal(
        disabled.DIAG_MARIADB_COLLATION_PROBE,
        MARIADB_COLLATION_PROBE_DISABLED,
      );
      assert.equal(apiConfig().diagnostics.mariaDbCollationProbeEnabled, false);

      const enabled = validateEnv({
        ...productionEnv,
        DIAG_MARIADB_COLLATION_PROBE: MARIADB_COLLATION_PROBE_CONFIRMATION,
      });
      assert.equal(
        enabled.DIAG_MARIADB_COLLATION_PROBE,
        MARIADB_COLLATION_PROBE_CONFIRMATION,
      );
      assert.equal(apiConfig().diagnostics.mariaDbCollationProbeEnabled, true);

      assert.throws(
        () =>
          validateEnv({
            ...productionEnv,
            DIAG_MARIADB_COLLATION_PROBE: "enabled",
          }),
        /DIAG_MARIADB_COLLATION_PROBE must be DISABLED/,
      );
      assert.throws(() =>
        validateEnv({
          ...productionEnv,
          DIAG_MARIADB_COLLATION_PROBE: ` ${MARIADB_COLLATION_PROBE_CONFIRMATION}`,
        }),
      );
    } finally {
      process.env = previousEnv;
    }
  });
});

describe("MariaDB collation probe execution", () => {
  it("does nothing when disabled", async () => {
    const { service, prisma, logger } = createService({ enabled: false });
    await service.runOnceAfterListen();
    assert.equal(prisma.calls.length, 0);
    assert.equal(logger.events.length, 0);
  });

  it("uses the existing Prisma service for session, parameter/literal, and CONCAT metadata exactly once", async () => {
    const { service, prisma, logger } = createService();
    await service.runOnceAfterListen();
    await service.runOnceAfterListen();

    assert.equal(prisma.calls.length, 3);
    assert.deepEqual(
      prisma.calls.map(({ values }) => values.length),
      [0, 3, 3],
    );
    assert.equal(logger.events.length, 1);
    assert.deepEqual(logger.events[0], {
      event: MARIADB_COLLATION_PROBE_EVENT,
      status: "COMPLETED",
      session: SESSION_ROW,
      parameter: {
        charset: "utf8mb4",
        collation: "utf8mb4_uca1400_ai_ci",
        coercibility: 6,
      },
      literal: {
        charset: "utf8mb4",
        collation: "utf8mb4_unicode_ci",
        coercibility: 6,
      },
      concat: {
        status: "PASS",
        charset: "utf8mb4",
        collation: "utf8mb4_uca1400_ai_ci",
        coercibility: 6,
      },
    });
  });

  it("bounds the optional character-set collation map", async () => {
    const { service, logger } = createService({
      prisma: new FakeProbePrisma([
        [{ ...SESSION_ROW, characterSetCollations: "a".repeat(700) }],
        [PARAMETER_ROW],
        [CONCAT_ROW],
      ]),
    });
    await service.runOnceAfterListen();
    const result = logger.events[0];
    assert.ok(result && result.status === "COMPLETED");
    assert.equal(result.session.characterSetCollations?.length, 512);
    assert.ok(result.session.characterSetCollations?.endsWith("..."));
  });

  it("emits only bounded metadata when CONCAT returns MariaDB 1267", async () => {
    const rawMessage =
      "Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and " +
      "(utf8mb4_uca1400_ai_ci,COERCIBLE) for operation 'concat'";
    const prisma = new FakeProbePrisma([
      [SESSION_ROW],
      [PARAMETER_ROW],
      driver1267(rawMessage),
    ]);
    const { service, logger } = createService({ prisma });
    await service.runOnceAfterListen();

    assert.deepEqual(logger.events[0], {
      event: MARIADB_COLLATION_PROBE_EVENT,
      status: "CONCAT_FAILED",
      session: SESSION_ROW,
      parameter: {
        charset: "utf8mb4",
        collation: "utf8mb4_uca1400_ai_ci",
        coercibility: 6,
      },
      literal: {
        charset: "utf8mb4",
        collation: "utf8mb4_unicode_ci",
        coercibility: 6,
      },
      driver: { code: 1267, sqlState: "HY000" },
      conflict: {
        leftCollation: "utf8mb4_unicode_ci",
        leftCoercibility: "IMPLICIT",
        rightCollation: "utf8mb4_uca1400_ai_ci",
        rightCoercibility: "COERCIBLE",
        operation: "concat",
      },
    });

    const serialized = JSON.stringify(logger.events[0]);
    for (const forbidden of [
      rawMessage,
      "SELECT private_value",
      "diagnostic",
      "DATABASE_URL",
      "private-host",
      "private-database",
      "private-user",
      "private-password",
      "parameters",
      "stack",
    ]) {
      assert.ok(!serialized.includes(forbidden), `leaked: ${forbidden}`);
    }
  });

  it("keeps pre-CONCAT failures generic and excludes their raw driver payload", async () => {
    const rawMessage =
      "Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and " +
      "(utf8mb4_general_ci,COERCIBLE) for operation 'select'";
    const { service, logger } = createService({
      prisma: new FakeProbePrisma([driver1267(rawMessage)]),
    });
    await service.runOnceAfterListen();

    assert.deepEqual(logger.events, [
      {
        event: MARIADB_COLLATION_PROBE_EVENT,
        status: "FAILED",
        driver: { code: 1267, sqlState: "HY000" },
      },
    ]);
    const serialized = JSON.stringify(logger.events);
    assert.ok(!serialized.includes(rawMessage));
    assert.ok(!serialized.includes("private-host"));
    assert.ok(!serialized.includes("private-password"));
  });

  it("emits TIMEOUT without throwing or logging late query data", async () => {
    const lateSession = new Promise<unknown[]>((resolve) =>
      setTimeout(() => resolve([SESSION_ROW]), 20),
    );
    const prisma = new FakeProbePrisma([lateSession]);
    const { service, logger } = createService({ prisma });
    await service.runOnceAfterListen(5);
    assert.deepEqual(logger.events, [
      { event: MARIADB_COLLATION_PROBE_EVENT, status: "TIMEOUT" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(prisma.calls.length, 1);
    assert.equal(logger.events.length, 1);
  });

  it("uses only the injected PrismaService and tagged read-only queries", () => {
    const source = readFileSync(
      "src/common/diagnostics/mariadb-collation-probe.service.ts",
      "utf8",
    );
    assert.ok(source.includes("private readonly prisma: PrismaService"));
    assert.ok(!source.includes("new PrismaClient"));
    assert.ok(!source.includes("PrismaMariaDb"));
    assert.ok(!source.includes("$queryRawUnsafe"));
    assert.ok(!source.includes("FROM VideoAsset"));
    for (const mutation of [
      "INSERT ",
      "UPDATE ",
      "DELETE ",
      "ALTER ",
      "DROP ",
    ]) {
      assert.ok(!source.includes(mutation), `mutation found: ${mutation}`);
    }
  });
});

describe("MariaDB 1267 collation parser", () => {
  it("parses representative quote and punctuation variants", () => {
    assert.deepEqual(
      parseMariaDbCollationConflict(
        driver1267(
          "Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and " +
            "(utf8mb4_uca1400_ai_ci,COERCIBLE) for operation 'like'",
        ),
      ),
      {
        leftCollation: "utf8mb4_unicode_ci",
        leftCoercibility: "IMPLICIT",
        rightCollation: "utf8mb4_uca1400_ai_ci",
        rightCoercibility: "COERCIBLE",
        operation: "like",
      },
    );
    assert.equal(
      parseMariaDbCollationConflict(
        driver1267(
          "Illegal mix of collations (utf8mb4_unicode_ci, IMPLICIT), " +
            "(utf8mb4_general_ci, COERCIBLE) for operation `concat`",
        ),
      )?.operation,
      "concat",
    );
  });

  it("rejects non-1267, malformed, hostile, non-string, and overlong messages", () => {
    const non1267 = driver1267(
      "Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and " +
        "(utf8mb4_general_ci,COERCIBLE) for operation 'concat'",
    ) as Error & { cause: Record<string, unknown> };
    non1267.cause.code = 1064;
    non1267.cause.originalCode = "1064";

    assert.equal(parseMariaDbCollationConflict(non1267), undefined);
    assert.equal(
      parseMariaDbCollationConflict(
        driver1267(
          "Illegal mix of collations (utf8mb4-unicode-ci,IMPLICIT) and " +
            "(utf8mb4_general_ci,COERCIBLE) for operation 'concat'",
        ),
      ),
      undefined,
    );
    assert.equal(
      parseMariaDbCollationConflict(
        driver1267(
          "Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and " +
            "(utf8mb4_general_ci,COERCIBLE) for operation 'concat'; DROP",
        ),
      ),
      undefined,
    );
    assert.equal(
      parseMariaDbCollationConflict(
        driver1267(
          "Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and " +
            "(utf8mb4_general_ci,COERCIBLE) for operation 'concat\"",
        ),
      ),
      undefined,
    );
    assert.equal(parseMariaDbCollationConflict(driver1267(42)), undefined);
    assert.equal(
      parseMariaDbCollationConflict(driver1267("x".repeat(2049))),
      undefined,
    );
    assert.equal(parseMariaDbCollationConflict(new Error("plain")), undefined);
  });

  it("handles missing and circular cause graphs without unbounded traversal", () => {
    const circular: Record<string, unknown> = {
      kind: "mysql",
      code: 1267,
      originalCode: "1267",
      originalMessage:
        "Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and " +
        "(utf8mb4_general_ci,COERCIBLE) for operation 'concat'",
    };
    circular.cause = circular;
    const error = Object.assign(new Error("wrapper"), { cause: circular });

    assert.equal(
      parseMariaDbCollationConflict(error)?.rightCollation,
      "utf8mb4_general_ci",
    );
    assert.equal(
      parseMariaDbCollationConflict({ code: 1267, cause: null }),
      undefined,
    );

    const nested = Object.assign(new Error("outer"), {
      cause: Object.assign(new Error("adapter"), {
        name: "DriverAdapterError",
        cause: {
          kind: "mysql",
          code: 1267,
          originalMessage:
            "Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and " +
            "(utf8mb4_general_ci,COERCIBLE) for operation 'concat'",
        },
      }),
    });
    assert.equal(parseMariaDbCollationConflict(nested)?.operation, "concat");
  });
});

describe("MariaDB collation probe startup isolation", () => {
  it("catches probe rejection and is launched only after app.listen in source", async () => {
    let caught = 0;
    launchMariaDbCollationProbeAfterListen(
      {
        runOnceAfterListen: async () => {
          throw new Error("private failure");
        },
      },
      () => {
        caught += 1;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(caught, 1);

    const source = readFileSync("src/main.ts", "utf8");
    const listenIndex = source.indexOf("await app.listen(");
    const launchIndex = source.indexOf(
      "launchMariaDbCollationProbeAfterListen(",
    );
    assert.ok(listenIndex >= 0);
    assert.ok(launchIndex > listenIndex);
    assert.ok(!source.includes("await probe.runOnceAfterListen"));
    assert.ok(!source.includes("process.exit"));
  });
});
