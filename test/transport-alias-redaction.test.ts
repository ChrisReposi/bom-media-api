/**
 * THE ALTERNATE BEARER CREDENTIAL IS NEVER OBSERVABLE.
 *
 * `ShareLink.transportAlias` is the credential behind the email-safe reviewer
 * URL `/watch?r=<transportAlias>`. Possession of it, presented to
 * `POST /public/watch/exchange-compatible` on the bound host, grants access to
 * the same ShareLink that `#k` grants. It is therefore a SECRET of the same
 * class as `ShareLink.alias`, and every rule that protects `alias` applies to
 * it unchanged.
 *
 * This suite proves it never reaches a place a secret must not reach:
 *
 *   R1  application structured logs — the request serializer
 *   R2  application structured logs — the pino redaction contract
 *   R3  AccessLog rows, on every success and denial path
 *   R4  the response body of a denial
 *   R5  any Logger call made while the compatibility path runs
 *   R6  admin audit metadata, including the backfill row
 *   R7  a thrown error message
 *   R8  a DTO validation error
 *   R9  the sanitised database error context for a unique violation on the
 *       transport-alias index itself
 *
 * Only ONE artefact may ever contain it: the successful `compatibilityUrl`
 * response field, which is the whole point of the feature.
 *
 * These assertions search SERIALIZED output for the literal value rather than
 * inspecting named fields, so a leak through a field nobody thought of still
 * fails the test.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { BadRequestException, Logger } from "@nestjs/common";
import { validate } from "class-validator";
import { serializeRequestForLogs } from "../src/app.module";
import { buildCanonicalCompatibilityUrl } from "../src/admin-websites/utils/share-url.util";
import { toSafeDatabaseErrorContext } from "../src/common/errors/safe-database-error-context.util";
import { Prisma } from "../src/generated/prisma/client";
import { PublicWatchCompatibleExchangeDto } from "../src/public/dto/public-watch-compatible-exchange.dto";
import { sanitizeAccessLogReferer } from "../src/public/utils/access-log.util";
import {
  createCompatHarness,
  directUrlVideo,
  FOREIGN_HOST,
  LEGACY_ALIAS,
  LEGACY_HOST,
  LEGACY_TRANSPORT_ALIAS,
  localFileVideo,
  UNKNOWN_TRANSPORT_ALIAS,
} from "./share-link-compat-harness";

/** The one value this whole suite hunts for. */
const SECRET = LEGACY_TRANSPORT_ALIAS;

function harness(overrides: Record<string, unknown> = {}) {
  return createCompatHarness({
    videos: [directUrlVideo(), localFileVideo()],
    ...overrides,
    shareLink: {
      transportAlias: SECRET,
      ...((overrides.shareLink as Record<string, unknown>) ?? {}),
    },
  });
}

/**
 * Captures every argument passed to any Logger method for the duration of a
 * callback. The services build their own `new Logger(...)` internally, so the
 * prototype is the only seam — and it is the right one: it catches a log line
 * from ANY collaborator the call touches, not only the one under test.
 */
const LOGGER_METHODS = ["log", "error", "warn", "debug", "verbose"] as const;

async function captureLoggerOutput(
  run: () => Promise<unknown>,
): Promise<string> {
  const captured: unknown[] = [];
  const originals = new Map<string, unknown>();

  for (const method of LOGGER_METHODS) {
    const prototype = Logger.prototype as unknown as Record<string, unknown>;
    originals.set(method, prototype[method]);
    prototype[method] = (...args: unknown[]): void => {
      captured.push(...args);
    };
  }

  try {
    await run();
  } finally {
    for (const method of LOGGER_METHODS) {
      (Logger.prototype as unknown as Record<string, unknown>)[method] =
        originals.get(method);
    }
  }

  return captured
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry instanceof Error) return `${entry.name}: ${entry.message}`;
      try {
        return JSON.stringify(entry);
      } catch {
        return String(entry);
      }
    })
    .join("\n");
}

afterEach(() => {
  // A failed assertion inside captureLoggerOutput must not leave the
  // prototype patched for the rest of the run.
  for (const method of LOGGER_METHODS) {
    const prototype = Logger.prototype as unknown as Record<string, unknown>;
    if (typeof prototype[method] !== "function") {
      throw new Error(`Logger.${method} was left unpatched`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * R1 / R2 — application structured logs
 * ------------------------------------------------------------------ */

describe("R1 the request serializer cannot emit a credential", () => {
  it("emits only id, method and a route template — never a body, query or header", () => {
    const serialized = serializeRequestForLogs({
      id: "req-1",
      method: "POST",
      // Everything below is what a real compatibility exchange carries.
      body: { host: LEGACY_HOST, alias: SECRET },
      query: { r: SECRET, token: LEGACY_ALIAS },
      headers: { authorization: "Bearer x", referer: `/watch?r=${SECRET}` },
      originalUrl: `/api/v1/public/watch/exchange-compatible?r=${SECRET}`,
      url: `/watch?r=${SECRET}`,
      route: { path: "/public/watch/exchange-compatible" },
      baseUrl: "/api/v1",
    });

    assert.deepEqual(Object.keys(serialized).sort(), ["id", "method", "route"]);
    assert.equal(serialized.route, "/api/v1/public/watch/exchange-compatible");

    const text = JSON.stringify(serialized);
    assert.equal(text.includes(SECRET), false, "transport alias leaked");
    assert.equal(text.includes(LEGACY_ALIAS), false, "share alias leaked");
    assert.equal(text.includes("Bearer"), false);
  });

  it("still emits nothing when the request is the raw-wrapped shape", () => {
    const serialized = serializeRequestForLogs({
      raw: {
        id: "req-2",
        method: "POST",
        body: { alias: SECRET },
        route: { path: "/public/watch/exchange-compatible" },
      },
    });

    assert.equal(JSON.stringify(serialized).includes(SECRET), false);
  });
});

describe("R2 the pino redaction contract names both bearer credentials", () => {
  it("censors the credential-bearing body and query fields", () => {
    // Structural: the redaction list lives inline in the module decorator, so
    // it is asserted from source. It is the SECOND layer — R1 proves no body
    // or query reaches a log line today — and exists so that adding a body
    // serializer later cannot silently start logging a credential.
    const source = readFileSync(
      new URL("../src/app.module.ts", import.meta.url),
      "utf8",
    );
    const redactBlock = source.match(/redact:\s*\{[\s\S]*?\},/)?.[0] ?? "";

    for (const path of [
      '"req.headers.authorization"',
      '"req.headers.cookie"',
      '"req.query.token"',
      '"req.query.grant"',
      '"req.body.token"',
      '"req.body.alias"',
      '"req.query.r"',
    ]) {
      assert.ok(redactBlock.includes(path), `redact path missing: ${path}`);
    }
    assert.match(redactBlock, /censor:\s*"\[Redacted\]"/);
  });
});

/* ------------------------------------------------------------------ *
 * R3 / R4 / R5 — the compatibility exchange itself
 * ------------------------------------------------------------------ */

describe("R3/R4/R5 the compatibility exchange never observes the credential", () => {
  const REQUEST_META = {
    ip: "203.0.113.10",
    userAgent: "redaction-suite",
    referer: undefined,
  };

  it("writes no AccessLog row containing it, on ANY path", async () => {
    const { service, prisma } = harness();

    // Success, unknown alias, malformed alias, wrong host, missing host.
    await service.resolvePublicWatchCompatible({
      host: LEGACY_HOST,
      alias: SECRET,
      requestMeta: REQUEST_META,
    });
    await service.resolvePublicWatchCompatible({
      host: LEGACY_HOST,
      alias: UNKNOWN_TRANSPORT_ALIAS,
      requestMeta: REQUEST_META,
    });
    await service.resolvePublicWatchCompatible({
      host: LEGACY_HOST,
      alias: `${SECRET}-malformed`,
      requestMeta: REQUEST_META,
    });
    await service.resolvePublicWatchCompatible({
      host: FOREIGN_HOST,
      alias: SECRET,
      requestMeta: REQUEST_META,
    });
    await service.resolvePublicWatchCompatible({
      host: "not a host",
      alias: SECRET,
      requestMeta: REQUEST_META,
    });

    assert.ok(prisma.accessLogs.length >= 5, "paths did write access logs");
    const serialized = JSON.stringify(prisma.accessLogs);
    assert.equal(
      serialized.includes(SECRET),
      false,
      "transport alias in AccessLog",
    );
    assert.equal(
      serialized.includes(UNKNOWN_TRANSPORT_ALIAS),
      false,
      "a rejected transport alias in AccessLog",
    );
    assert.equal(
      serialized.includes(LEGACY_ALIAS),
      false,
      "share alias in AccessLog",
    );

    // The reason code is a fixed enum value, never derived from input.
    for (const row of prisma.accessLogs) {
      assert.ok(
        ["OK", "INVALID_LINK", "MISSING_HOST"].includes(row.reasonCode),
        row.reasonCode,
      );
    }
  });

  it("returns a denial body that contains neither credential", async () => {
    const { service } = harness();

    const denial = await service.resolvePublicWatchCompatible({
      host: LEGACY_HOST,
      alias: UNKNOWN_TRANSPORT_ALIAS,
      requestMeta: REQUEST_META,
    });

    const text = JSON.stringify(denial);
    assert.equal(text.includes(UNKNOWN_TRANSPORT_ALIAS), false);
    assert.equal(text.includes(SECRET), false);
    assert.deepEqual(denial, {
      valid: false,
      reasonCode: "INVALID_LINK",
      website: null,
      videos: [],
    });
  });

  it("logs nothing containing it, on the success path or any denial", async () => {
    const { service } = harness();

    const logged = await captureLoggerOutput(async () => {
      await service.resolvePublicWatchCompatible({
        host: LEGACY_HOST,
        alias: SECRET,
        requestMeta: REQUEST_META,
      });
      await service.resolvePublicWatchCompatible({
        host: LEGACY_HOST,
        alias: UNKNOWN_TRANSPORT_ALIAS,
        requestMeta: REQUEST_META,
      });
      await service.resolvePublicWatchCompatible({
        host: FOREIGN_HOST,
        alias: SECRET,
        requestMeta: REQUEST_META,
      });
    });

    assert.equal(logged.includes(SECRET), false, logged.slice(0, 300));
    assert.equal(logged.includes(UNKNOWN_TRANSPORT_ALIAS), false);
    assert.equal(logged.includes(LEGACY_ALIAS), false);
  });

  it("logs nothing containing it even when the pepper is missing (the SERVER_ERROR path)", async () => {
    // `resolvePublicWatch()` logs an error when SHARE_TOKEN_PEPPER is absent.
    // That log line must still not carry whatever credential was presented.
    const { service } = createCompatHarness({
      videos: [directUrlVideo()],
      pepper: "",
      shareLink: { transportAlias: SECRET },
    });

    const logged = await captureLoggerOutput(async () => {
      await service.resolvePublicWatchCompatible({
        host: LEGACY_HOST,
        alias: SECRET,
        requestMeta: REQUEST_META,
      });
    });

    assert.equal(logged.includes(SECRET), false, logged.slice(0, 300));
  });

  it("the SUCCESSFUL media URLs carry the share alias, never the transport alias", async () => {
    // The one artefact allowed to contain a credential is the response, and
    // even there the transport alias must not appear: media URLs are built
    // from the row's own `alias`.
    const { service } = harness();

    const response = await service.resolvePublicWatchCompatible({
      host: LEGACY_HOST,
      alias: SECRET,
      requestMeta: REQUEST_META,
    });

    assert.equal(response.valid, true);
    assert.equal(JSON.stringify(response).includes(SECRET), false);
  });
});

/* ------------------------------------------------------------------ *
 * R6 — audit metadata
 * ------------------------------------------------------------------ */

describe("R10 a REFERER can carry a credential, and never reaches AccessLog", () => {
  /* THE ONE INBOUND HEADER THAT CAN CARRY ONE.
   *
   * A reviewer whose browser sends a `Referer` sends the URL of the page they
   * came from — and two real reviewer URLs put a credential in the query:
   *
   *   /watch?r=<transportAlias>   the email-safe form, an ALTERNATE BEARER
   *                               CREDENTIAL for the ShareLink
   *   /?token=<rawToken>          the V1 legacy form, the RAW share token
   *
   * `AccessLog.referer` is durable storage that outlives the link, so a
   * client-side `Referrer-Policy` is not an acceptable defence: another
   * frontend, an older bundle, a rewriting proxy or a non-compliant browser
   * would each be enough. The value is reduced at the boundary instead. */

  const REFERER_META = (referer: string) => ({
    ip: "203.0.113.11",
    userAgent: "redaction-suite",
    referer,
  });

  it("stores the origin and path, dropping the query and the fragment", () => {
    assert.equal(
      sanitizeAccessLogReferer(`https://${LEGACY_HOST}/watch?r=${SECRET}`),
      `https://${LEGACY_HOST}/watch`,
    );
    assert.equal(
      sanitizeAccessLogReferer(`https://${LEGACY_HOST}/?token=s_raw-token`),
      `https://${LEGACY_HOST}/`,
    );
    assert.equal(
      sanitizeAccessLogReferer(
        `https://${LEGACY_HOST}/watch#k=${LEGACY_ALIAS}`,
      ),
      `https://${LEGACY_HOST}/watch`,
    );
    // A query INSIDE a fragment is dropped with the fragment.
    assert.equal(
      sanitizeAccessLogReferer(
        `https://${LEGACY_HOST}/w#/s/${LEGACY_ALIAS}?x=1`,
      ),
      `https://${LEGACY_HOST}/w`,
    );
    // The diagnostic value — which page the viewer came from — survives whole.
    assert.equal(
      sanitizeAccessLogReferer(`https://${LEGACY_HOST}/reviews/autumn-2026`),
      `https://${LEGACY_HOST}/reviews/autumn-2026`,
    );
    // Absent, blank and unparseable values degrade to null or to a bare
    // prefix, never to a stored credential.
    assert.equal(sanitizeAccessLogReferer(undefined), null);
    assert.equal(sanitizeAccessLogReferer("   "), null);
    assert.equal(sanitizeAccessLogReferer(`?r=${SECRET}`), null);
    assert.equal(sanitizeAccessLogReferer(`#k=${LEGACY_ALIAS}`), null);
  });

  it("writes no AccessLog row containing a referred credential, on ANY path", async () => {
    const { service, prisma } = harness();

    for (const referer of [
      `https://${LEGACY_HOST}/watch?r=${SECRET}`,
      `https://${LEGACY_HOST}/watch?r=${UNKNOWN_TRANSPORT_ALIAS}&v=video-x`,
      `https://${LEGACY_HOST}/?token=s_raw-token-value`,
      `https://${LEGACY_HOST}/watch#k=${LEGACY_ALIAS}`,
    ]) {
      // Both exchanges, and both outcomes, since every one of them logs.
      await service.resolvePublicWatchCompatible({
        host: LEGACY_HOST,
        alias: SECRET,
        requestMeta: REFERER_META(referer),
      });
      await service.resolvePublicWatchCompatible({
        host: LEGACY_HOST,
        alias: UNKNOWN_TRANSPORT_ALIAS,
        requestMeta: REFERER_META(referer),
      });
      await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        requestMeta: REFERER_META(referer),
      });
    }

    assert.ok(prisma.accessLogs.length >= 12, "every path wrote a row");
    const serialized = JSON.stringify(prisma.accessLogs);
    for (const [label, value] of [
      ["transport alias", SECRET],
      ["rejected transport alias", UNKNOWN_TRANSPORT_ALIAS],
      ["share alias", LEGACY_ALIAS],
      ["raw share token", "s_raw-token-value"],
    ] as const) {
      assert.equal(
        serialized.includes(value),
        false,
        `${label} reached AccessLog through the referer`,
      );
    }

    // Positive control: the referer IS still recorded, minus its query.
    const stored = prisma.accessLogs
      .map((row) => (row as { referer?: string | null }).referer)
      .filter((value): value is string => typeof value === "string");
    assert.ok(stored.length >= 12, "the referer column is still populated");
    for (const value of stored) {
      assert.ok(
        value === `https://${LEGACY_HOST}/watch` ||
          value === `https://${LEGACY_HOST}/`,
        value,
      );
    }
  });
});

describe("R6 admin audit metadata never carries it", () => {
  it("records no credential on any audit row written by a share-link mutation", async () => {
    const { adminWebsites, prisma } = harness();

    await adminWebsites.revokeShareLink("share-link-compat-1", "admin-1");

    assert.ok(prisma.auditLogs.length > 0);
    const serialized = JSON.stringify(prisma.auditLogs);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes(LEGACY_ALIAS), false);
  });
});

/* ------------------------------------------------------------------ *
 * R7 / R8 / R9 — errors
 * ------------------------------------------------------------------ */

describe("R7 a thrown error never echoes the value", () => {
  it("refuses a malformed transport alias without repeating it", () => {
    const bad = `${SECRET}-not-valid`;

    assert.throws(
      () =>
        buildCanonicalCompatibilityUrl({
          host: "example.com",
          transportAlias: bad,
          protocol: "https",
        }),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        const text = `${error.message} ${JSON.stringify(error.getResponse())}`;
        assert.equal(text.includes(bad), false, text);
        assert.equal(text.includes(SECRET), false, text);
        return true;
      },
    );
  });
});

describe("R8 a DTO validation error never echoes the value", () => {
  it("reports the constraint, not the submitted credential", async () => {
    const dto = new PublicWatchCompatibleExchangeDto();
    dto.host = LEGACY_HOST;
    dto.alias = `${SECRET}${"x".repeat(64)}`;

    const errors = await validate(dto);
    const messages = JSON.stringify(
      errors.map((error) => error.constraints ?? {}),
    );

    assert.ok(errors.length > 0, "an oversized alias is rejected");
    assert.equal(messages.includes(SECRET), false, messages);
    assert.match(messages, /alias/);
  });
});

describe("R9 a unique violation on the transport-alias index exposes no value", () => {
  it("keeps the index NAME and drops everything else", () => {
    // A driver may put the offending VALUE in its own message. The sanitiser
    // must expose only structural identifiers.
    const error = new Prisma.PrismaClientKnownRequestError(
      `Unique constraint failed on ShareLink_transportAlias_key value '${SECRET}'`,
      {
        code: "P2002",
        clientVersion: "7.8.0",
        meta: {
          target: "ShareLink_transportAlias_key",
          driverAdapterError: {
            cause: {
              kind: "UniqueConstraintViolation",
              constraint: {
                index: "ShareLink_transportAlias_key",
                fields: ["transportAlias"],
              },
            },
          },
        },
      },
    );

    const context = toSafeDatabaseErrorContext(error);
    const serialized = JSON.stringify(context);

    assert.equal(serialized.includes(SECRET), false, serialized);
    // The structural identifiers survive, so the failure stays diagnosable.
    assert.equal(context?.errorCode, "P2002");
    assert.match(serialized, /transportAlias/);
  });
});
