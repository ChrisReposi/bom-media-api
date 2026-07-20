/**
 * Opt-in, destructive-only-to-its-own-fixtures MariaDB 11.8 protocol proof.
 * It runs the production query paths through real Nest HTTP with both driver
 * protocols. Output is limited to protocol labels, statuses and aggregate
 * counts; credentials, tokens, SQL, row data and checksums are never printed.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createServer } from "node:net";
import { hash } from "bcryptjs";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import {
  AccountStatus,
  AdminRole,
  PrismaClient,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
} from "../../src/generated/prisma/client";
import {
  assertMariaDbVideoQueryProofDatabase,
  buildMariaDbProofIdentity,
  MARIADB_VIDEO_QUERY_FIXTURE_COUNT,
  protocolLabel,
  type MariaDbProofIdentity,
} from "./mariadb-video-query-protocol-proof-core";
import { toSafeDiagnosticFailure } from "../diagnostics/admin-video-query-isolation-core";

type JsonObject = Record<string, unknown>;

function writeSafe(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function databaseConfig(): {
  pool: ConstructorParameters<typeof PrismaMariaDb>[0];
  database: string;
} {
  const rawUrl = process.env.DATABASE_URL?.trim();
  assert.ok(rawUrl, "DATABASE_URL is required");
  const url = new URL(rawUrl);
  const database = url.pathname.replace(/^\//, "");
  assert.ok(database, "test database name is required");
  return {
    database,
    pool: {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
      connectionLimit: 5,
      connectTimeout: 10_000,
      acquireTimeout: 10_000,
      idleTimeout: 60,
      allowPublicKeyRetrieval: true,
    },
  };
}

function createClient(useTextProtocol: boolean): PrismaClient {
  const { pool } = databaseConfig();
  return new PrismaClient({
    adapter: new PrismaMariaDb(pool, { useTextProtocol }),
  });
}

function asObject(value: unknown, label: string): JsonObject {
  assert.ok(value !== null && typeof value === "object", `${label} object`);
  assert.ok(!Array.isArray(value), `${label} not array`);
  return value as JsonObject;
}

function asArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} array`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  assert.equal(typeof value, "number", `${label} number`);
  return value as number;
}

async function requestJson(params: {
  baseUrl: string;
  path: string;
  accessToken?: string;
  method?: string;
  body?: Record<string, unknown>;
}): Promise<{ status: number; body: JsonObject }> {
  const headers = new Headers();
  if (params.accessToken) {
    headers.set("Authorization", `Bearer ${params.accessToken}`);
  }
  if (params.body) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${params.baseUrl}${params.path}`, {
    method: params.method ?? "GET",
    headers,
    body: params.body ? JSON.stringify(params.body) : undefined,
  });
  const body = asObject(await response.json(), "HTTP response");
  return { status: response.status, body };
}

async function createFixtures(
  prisma: PrismaClient,
  identity: MariaDbProofIdentity,
): Promise<{ password: string }> {
  const password = `T3st-${identity.runId}-Passphrase`;
  const passwordHash = await hash(password, 4);
  await prisma.adminUser.create({
    data: {
      id: identity.adminId,
      username: identity.adminUsername,
      passwordHash,
      role: AdminRole.OWNER,
      status: AccountStatus.ACTIVE,
    },
  });
  await prisma.website.create({
    data: {
      id: identity.websiteId,
      name: "MariaDB protocol proof website",
      slug: identity.websiteSlug,
      status: WebsiteStatus.ACTIVE,
    },
  });

  const viewCount = 9_007_199_254_740_993n;
  const sizeBytes = 9_007_199_254_740_995n;
  await prisma.videoAsset.createMany({
    data: Array.from({ length: MARIADB_VIDEO_QUERY_FIXTURE_COUNT }, (_, i) => ({
      id: `${identity.videoIdPrefix}${String(i).padStart(3, "0")}`,
      title: `SML MariaDB protocol fixture ${i}`,
      slug: `${identity.videoSlugPrefix}${i}`,
      provider: VideoProvider.MANUAL,
      sourceType: VideoSourceType.LOCAL_FILE,
      status: VideoStatus.READY,
      filterKey: "sml",
      viewCount,
      metadataJson: { fixture: "mariadb-protocol-proof" },
    })),
  });
  await prisma.videoLocalFileAsset.createMany({
    data: Array.from({ length: MARIADB_VIDEO_QUERY_FIXTURE_COUNT }, (_, i) => ({
      id: `${identity.runId}_local_${i}`,
      videoId: `${identity.videoIdPrefix}${String(i).padStart(3, "0")}`,
      storageKey: `${identity.runId}/video-${i}.mp4`,
      originalFilename: `fixture-${i}.mp4`,
      mimeType: "video/mp4",
      sizeBytes,
      checksumSha256: "a".repeat(64),
    })),
  });
  await prisma.videoLocalThumbnailAsset.createMany({
    data: Array.from({ length: MARIADB_VIDEO_QUERY_FIXTURE_COUNT }, (_, i) => ({
      id: `${identity.runId}_thumbnail_${i}`,
      videoId: `${identity.videoIdPrefix}${String(i).padStart(3, "0")}`,
      storageKey: `${identity.runId}/thumbnail-${i}.jpg`,
      originalFilename: `fixture-${i}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 4096n,
      checksumSha256: "b".repeat(64),
    })),
  });
  return { password };
}

async function cleanupFixtures(
  prisma: PrismaClient,
  identity: MariaDbProofIdentity,
): Promise<void> {
  await prisma.adminUser.deleteMany({ where: { id: identity.adminId } });
  await prisma.website.deleteMany({ where: { id: identity.websiteId } });
  await prisma.videoAsset.deleteMany({
    where: { id: { startsWith: identity.videoIdPrefix } },
  });

  const [admins, websites, videos, localFiles, thumbnails] = await Promise.all([
    prisma.adminUser.count({ where: { id: identity.adminId } }),
    prisma.website.count({ where: { id: identity.websiteId } }),
    prisma.videoAsset.count({
      where: { id: { startsWith: identity.videoIdPrefix } },
    }),
    prisma.videoLocalFileAsset.count({
      where: { storageKey: { startsWith: `${identity.runId}/` } },
    }),
    prisma.videoLocalThumbnailAsset.count({
      where: { storageKey: { startsWith: `${identity.runId}/` } },
    }),
  ]);
  assert.deepEqual(
    { admins, websites, videos, localFiles, thumbnails },
    { admins: 0, websites: 0, videos: 0, localFiles: 0, thumbnails: 0 },
  );
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(
    address !== null && typeof address === "object",
    "local port unavailable",
  );
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function startApi(
  useTextProtocol: boolean,
): Promise<{ child: ChildProcess; baseUrl: string }> {
  const port = await reserveLocalPort();
  const child = spawn(
    process.execPath,
    [join(__dirname, "mariadb-video-query-protocol-proof-api.cjs")],
    {
      cwd: join(__dirname, "../.."),
      env: {
        ...process.env,
        APP_ENV: "test",
        API_HOST: "127.0.0.1",
        API_PORT: String(port),
        API_INTERNAL_DOCS_ENABLED: "false",
        DB_MARIADB_USE_TEXT_PROTOCOL: String(useTextProtocol),
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 20_000;
    let settled = false;
    const check = async (): Promise<void> => {
      if (settled) return;
      if (child.exitCode !== null) {
        settled = true;
        reject(new Error("MariaDB proof API exited before readiness."));
        return;
      }
      try {
        const response = await fetch(`${baseUrl}/api/v1/health/ready`);
        if (response.status === 200) {
          settled = true;
          resolve();
          return;
        }
      } catch {
        // Bounded retry while the isolated local child starts.
      }
      if (Date.now() >= deadline) {
        settled = true;
        reject(new Error("MariaDB proof API readiness timed out."));
        return;
      }
      setTimeout(() => void check(), 100);
    };
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    void check();
  });
  return { child, baseUrl };
}

async function stopApi(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function runProtocol(params: {
  useTextProtocol: boolean;
  identity: MariaDbProofIdentity;
  password: string;
}): Promise<void> {
  const protocol = protocolLabel(params.useTextProtocol);
  const { child, baseUrl } = await startApi(params.useTextProtocol);
  try {
    const login = await requestJson({
      baseUrl,
      path: "/api/v1/admin/auth/login",
      method: "POST",
      body: {
        username: params.identity.adminUsername,
        password: params.password,
      },
    });
    assert.equal(login.status, 200);
    const tokens = asObject(login.body.tokens, "tokens");
    const accessToken = tokens.accessToken;
    assert.equal(typeof accessToken, "string");

    const paths = {
      globalNoSearch:
        "/api/v1/admin/videos?page=1&limit=20&status=READY&sortBy=createdAt&sortOrder=desc",
      globalSearch:
        "/api/v1/admin/videos?page=1&limit=20&search=sml&status=READY&sortBy=createdAt&sortOrder=desc",
      assigned: `/api/v1/admin/websites/${params.identity.websiteId}/videos?page=1&limit=24&assignmentStatus=ACTIVE&eligibleForShareLink=true`,
      options: `/api/v1/admin/websites/${params.identity.websiteId}/video-assignment-options?page=1&limit=24`,
    };
    const results = await Promise.all(
      Object.entries(paths).map(async ([operation, path]) => ({
        operation,
        result: await requestJson({
          baseUrl,
          path,
          accessToken: accessToken as string,
        }),
      })),
    );

    const byOperation = Object.fromEntries(
      results.map(({ operation, result }) => [operation, result]),
    ) as Record<string, { status: number; body: JsonObject }>;
    for (const result of Object.values(byOperation)) {
      assert.equal(result.status, 200);
      JSON.stringify(result.body);
    }

    for (const operation of ["globalNoSearch", "globalSearch"]) {
      const response = byOperation[operation];
      assert.ok(response);
      assert.equal(
        asArray(response.body.items, `${operation}.items`).length,
        20,
      );
      const meta = asObject(response.body.meta, `${operation}.meta`);
      assert.equal(
        asNumber(meta.total, `${operation}.total`),
        MARIADB_VIDEO_QUERY_FIXTURE_COUNT,
      );
      const first = asObject(
        asArray(response.body.items, `${operation}.items`)[0],
        `${operation}.first`,
      );
      assert.equal(first.viewCount, "9007199254740993");
      const localFile = asObject(first.localFileAsset, "localFileAsset");
      assert.equal(localFile.sizeBytes, "9007199254740995");
    }

    const assigned = byOperation.assigned;
    assert.ok(assigned);
    assert.equal(asArray(assigned.body.items, "assigned.items").length, 0);
    assert.equal(
      asNumber(asObject(assigned.body.meta, "assigned.meta").total, "total"),
      0,
    );

    const options = byOperation.options;
    assert.ok(options);
    assert.equal(asArray(options.body.items, "options.items").length, 24);
    const optionsMeta = asObject(options.body.meta, "options.meta");
    assert.equal(
      asNumber(optionsMeta.total, "options.total"),
      MARIADB_VIDEO_QUERY_FIXTURE_COUNT,
    );
    assert.equal(optionsMeta.activeAssignmentTotal, 0);
    assert.equal(
      optionsMeta.eligibleCandidateTotal,
      MARIADB_VIDEO_QUERY_FIXTURE_COUNT,
    );
    assert.deepEqual(optionsMeta.activeAssignedVideoIds, []);

    writeSafe({
      protocol,
      status: "PASS",
      globalNoSearchTotal: MARIADB_VIDEO_QUERY_FIXTURE_COUNT,
      globalSearchTotal: MARIADB_VIDEO_QUERY_FIXTURE_COUNT,
      assignedTotal: 0,
      assignmentOptionsTotal: MARIADB_VIDEO_QUERY_FIXTURE_COUNT,
      mapperAndHttpSerialization: "PASS",
      bigintSerialization: "PASS",
    });
  } finally {
    await stopApi(child);
  }
}

async function main(): Promise<void> {
  const target = assertMariaDbVideoQueryProofDatabase();
  const identity = buildMariaDbProofIdentity();
  const setup = createClient(true);
  await setup.$connect();
  let fixturesCreated = false;
  try {
    const versionRows = await setup.$queryRaw<Array<{ version: string }>>`
      SELECT VERSION() AS version
    `;
    const version = versionRows[0]?.version ?? "";
    assert.match(version, /^11\.8\.8-MariaDB/i);
    const appliedMigrations = await setup.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    assert.equal(Number(appliedMigrations[0]?.count ?? 0n), 19);
    writeSafe({
      database: target.database,
      hostClassification: "local",
      server: "MariaDB 11.8.8",
      migrations: 19,
    });

    fixturesCreated = true;
    const { password } = await createFixtures(setup, identity);
    assert.equal(
      await setup.videoAsset.count({
        where: { id: { startsWith: identity.videoIdPrefix } },
      }),
      MARIADB_VIDEO_QUERY_FIXTURE_COUNT,
    );
    assert.equal(
      await setup.websiteVideo.count({
        where: { websiteId: identity.websiteId },
      }),
      0,
    );

    await runProtocol({
      useTextProtocol: false,
      identity,
      password,
    });
    await runProtocol({
      useTextProtocol: true,
      identity,
      password,
    });
  } catch (error) {
    writeSafe({
      status: "FAIL",
      database: target.database,
      failure: toSafeDiagnosticFailure(error),
    });
    throw error;
  } finally {
    if (fixturesCreated) {
      await cleanupFixtures(setup, identity);
      writeSafe({ cleanup: "PASS", runScopedLeftovers: 0 });
    }
    await setup.$disconnect();
  }
}

void main().catch((error: unknown) => {
  writeSafe({
    status: "FAIL",
    fatal: toSafeDiagnosticFailure(error),
  });
  process.exitCode = 1;
});
