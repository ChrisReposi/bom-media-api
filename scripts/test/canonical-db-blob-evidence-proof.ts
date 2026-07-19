/**
 * Opt-in Gate 3C-1 proof. It exercises real Nest HTTP routes and real MySQL
 * only after the destructive guard confirms the isolated test database.
 * Every fixture is run-scoped and cleanup is mandatory, even on failure.
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { hash } from "bcryptjs";
import { loadApiEnv } from "../../src/config/load-env";
import {
  AccountStatus,
  AdminRole,
  AssignmentStatus,
  AuditStatus,
  DomainStatus,
  Prisma,
  PrismaClient,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
} from "../../src/generated/prisma/client";
import type { CanonicalShareLinkService } from "../../src/admin-websites/canonical-share-link.service";
import { computeSha256Hex } from "../../src/videos/utils/video-checksum.util";
import { assertDestructiveTestDatabase } from "../safety/assert-destructive-test-database";
import {
  assertGate3c1Database,
  buildGate3c1CleanupScope,
  buildGate3c1FixtureIdentity,
  safeProofMessage,
  type Gate3c1FixtureIdentity,
} from "./canonical-db-blob-evidence-proof-core";

type JsonObject = Record<string, unknown>;
type CanonicalAdoptionService = Pick<
  CanonicalShareLinkService,
  "adoptExistingShareLink"
>;

type DatabaseCounts = {
  Website: number;
  WebsiteDomain: number;
  VideoAsset: number;
  VideoBinaryAsset: number;
  WebsiteVideo: number;
  ShareLink: number;
  ShareLinkVideo: number;
  CanonicalVideoShareLink: number;
  AdminAuditLog: number;
  AdminUser: number;
  AdminSession: number;
  AdminRefreshToken: number;
};

type ProofState = {
  uploadedVideoId: string | null;
  canonicalShareLinkId: string | null;
  genericShareLinkId: string | null;
};

class ProofAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofAssertionError";
  }
}

function invariant(condition: unknown, label: string): asserts condition {
  if (!condition) {
    throw new ProofAssertionError(label);
  }
}

function asObject(value: unknown, label: string): JsonObject {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} is not an object`,
  );
  return value as JsonObject;
}

function stringField(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  invariant(typeof value === "string" && value.length > 0, `${label} missing`);
  return value;
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function assertNoCanonicalCredentials(response: JsonObject): void {
  invariant(
    !hasOwn(response, "rawToken"),
    "canonical response exposed rawToken",
  );
  invariant(
    !hasOwn(response, "tokenHash"),
    "canonical response exposed tokenHash",
  );
  const shareLink = asObject(response.shareLink, "canonical shareLink");
  invariant(
    !hasOwn(shareLink, "rawToken"),
    "canonical shareLink exposed rawToken",
  );
  invariant(
    !hasOwn(shareLink, "tokenHash"),
    "canonical shareLink exposed tokenHash",
  );
}

function stableErrorCode(value: unknown): string | null {
  const body =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : null;
  const code = body?.code;
  return typeof code === "string" && /^[A-Z0-9_]{3,80}$/.test(code)
    ? code
    : null;
}

async function requestJson(params: {
  baseUrl: string;
  path: string;
  label: string;
  expectedStatus: number;
  accessToken?: string;
  body?: BodyInit;
  method?: string;
  headers?: Record<string, string>;
}): Promise<JsonObject> {
  const headers = new Headers(params.headers);
  if (params.accessToken !== undefined) {
    headers.set("Authorization", `Bearer ${params.accessToken}`);
  }

  const response = await fetch(`${params.baseUrl}${params.path}`, {
    method: params.method ?? "GET",
    headers,
    body: params.body,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new ProofAssertionError(
      `${params.label} returned a non-JSON response with HTTP ${response.status}`,
    );
  }
  if (response.status !== params.expectedStatus) {
    const code = stableErrorCode(body);
    throw new ProofAssertionError(
      `${params.label} expected HTTP ${params.expectedStatus}, received ${response.status}${code === null ? "" : ` (${code})`}`,
    );
  }
  return asObject(body, `${params.label} response`);
}

function jsonBody(value: JsonObject): {
  body: string;
  headers: Record<string, string>;
} {
  return {
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  };
}

function databaseForm(params: {
  bytes: Buffer;
  filename: string;
  title?: string;
  slug?: string;
}): FormData {
  const form = new FormData();
  form.append(
    "file",
    new Blob([params.bytes], { type: "video/mp4" }),
    params.filename,
  );
  form.append("durationSeconds", "1");
  form.append("status", "READY");
  if (params.title !== undefined) {
    form.append("title", params.title);
  }
  if (params.slug !== undefined) {
    form.append("slug", params.slug);
  }
  return form;
}

async function countDatabase(prisma: PrismaClient): Promise<DatabaseCounts> {
  const counts = await Promise.all([
    prisma.website.count(),
    prisma.websiteDomain.count(),
    prisma.videoAsset.count(),
    prisma.videoBinaryAsset.count(),
    prisma.websiteVideo.count(),
    prisma.shareLink.count(),
    prisma.shareLinkVideo.count(),
    prisma.canonicalVideoShareLink.count(),
    prisma.adminAuditLog.count(),
    prisma.adminUser.count(),
    prisma.adminSession.count(),
    prisma.adminRefreshToken.count(),
  ]);
  return {
    Website: counts[0],
    WebsiteDomain: counts[1],
    VideoAsset: counts[2],
    VideoBinaryAsset: counts[3],
    WebsiteVideo: counts[4],
    ShareLink: counts[5],
    ShareLinkVideo: counts[6],
    CanonicalVideoShareLink: counts[7],
    AdminAuditLog: counts[8],
    AdminUser: counts[9],
    AdminSession: counts[10],
    AdminRefreshToken: counts[11],
  };
}

function assertSameCounts(
  before: DatabaseCounts,
  after: DatabaseCounts,
  label: string,
): void {
  for (const key of Object.keys(before) as Array<keyof DatabaseCounts>) {
    invariant(before[key] === after[key], `${label}: ${key} count changed`);
  }
}

async function canonicalWriteCounts(prisma: PrismaClient): Promise<{
  shareLinks: number;
  shareLinkVideos: number;
  canonicals: number;
  createSuccessAudits: number;
}> {
  const [shareLinks, shareLinkVideos, canonicals, createSuccessAudits] =
    await Promise.all([
      prisma.shareLink.count(),
      prisma.shareLinkVideo.count(),
      prisma.canonicalVideoShareLink.count(),
      prisma.adminAuditLog.count({
        where: {
          action: "CANONICAL_SHARE_LINK_CREATE",
          status: AuditStatus.SUCCESS,
        },
      }),
    ]);
  return { shareLinks, shareLinkVideos, canonicals, createSuccessAudits };
}

function assertEqualRecord(
  before: Record<string, number>,
  after: Record<string, number>,
  label: string,
): void {
  for (const key of Object.keys(before)) {
    invariant(before[key] === after[key], `${label}: ${key} changed`);
  }
}

async function verifyMigrations(prisma: PrismaClient): Promise<void> {
  const migrationsOnDisk = readdirSync(
    join(__dirname, "../../prisma/migrations"),
    { withFileTypes: true },
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  invariant(migrationsOnDisk.length === 19, "expected exactly 19 migrations");

  const applied = await prisma.$queryRaw<
    { migration_name: string }[]
  >`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const appliedNames = new Set(applied.map((row) => row.migration_name));
  invariant(
    appliedNames.size === 19,
    "test database has an unexpected migration count",
  );
  invariant(
    migrationsOnDisk.every((name) => appliedNames.has(name)),
    "test database is missing a repository migration",
  );
}

function createProofBuffers(): { bufferA: Buffer; bufferB: Buffer } {
  const header = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  const bufferA = Buffer.concat([header, Buffer.alloc(24, 0x41)]);
  const bufferB = Buffer.concat([header, Buffer.alloc(24, 0x42)]);
  invariant(bufferA.length === bufferB.length, "proof buffers differ in size");
  invariant(
    computeSha256Hex(bufferA) !== computeSha256Hex(bufferB),
    "proof buffers unexpectedly share a checksum",
  );
  return { bufferA, bufferB };
}

async function setupBaseFixtures(params: {
  prisma: PrismaClient;
  identity: Gate3c1FixtureIdentity;
  username: string;
  password: string;
  domain: string;
}): Promise<void> {
  const passwordHash = await hash(params.password, 12);
  await params.prisma.$transaction([
    params.prisma.adminUser.create({
      data: {
        id: params.identity.adminId,
        username: params.username,
        passwordHash,
        role: AdminRole.OWNER,
        status: AccountStatus.ACTIVE,
        mustChangePassword: false,
      },
    }),
    params.prisma.website.create({
      data: {
        id: params.identity.websiteId,
        name: `Gate 3C-1 ${params.identity.runId}`,
        slug: `${params.identity.runId.replace(/_/g, "-")}-site`,
        status: WebsiteStatus.ACTIVE,
      },
    }),
    params.prisma.websiteDomain.create({
      data: {
        id: params.identity.domainId,
        websiteId: params.identity.websiteId,
        domain: params.domain,
        isPrimary: true,
        status: DomainStatus.ACTIVE,
      },
    }),
  ]);
}

async function createLegacyNullFixture(params: {
  prisma: PrismaClient;
  identity: Gate3c1FixtureIdentity;
  domain: string;
  bytes: Buffer;
}): Promise<void> {
  await params.prisma.$transaction([
    params.prisma.website.create({
      data: {
        id: params.identity.legacyWebsiteId,
        name: `Gate 3C-1 legacy ${params.identity.runId}`,
        slug: `${params.identity.runId.replace(/_/g, "-")}-legacy`,
        status: WebsiteStatus.ACTIVE,
      },
    }),
    params.prisma.websiteDomain.create({
      data: {
        id: params.identity.legacyDomainId,
        websiteId: params.identity.legacyWebsiteId,
        domain: params.domain,
        isPrimary: true,
        status: DomainStatus.ACTIVE,
      },
    }),
    params.prisma.videoAsset.create({
      data: {
        id: params.identity.legacyVideoId,
        title: `Gate 3C-1 legacy video ${params.identity.runId}`,
        slug: `${params.identity.runId.replace(/_/g, "-")}-legacy-video`,
        provider: VideoProvider.MANUAL,
        sourceType: VideoSourceType.DB_BLOB,
        durationSeconds: 1,
        status: VideoStatus.READY,
        binaryAsset: {
          create: {
            id: params.identity.legacyBinaryId,
            mimeType: "video/mp4",
            sizeBytes: BigInt(params.bytes.length),
            data: params.bytes,
            checksumSha256: null,
          },
        },
      },
    }),
    params.prisma.websiteVideo.create({
      data: {
        id: params.identity.legacyAssignmentId,
        websiteId: params.identity.legacyWebsiteId,
        videoId: params.identity.legacyVideoId,
        status: AssignmentStatus.ACTIVE,
      },
    }),
  ]);
}

async function runHttpProof(params: {
  prisma: PrismaClient;
  canonicalService: CanonicalAdoptionService;
  identity: Gate3c1FixtureIdentity;
  state: ProofState;
  baseUrl: string;
  username: string;
  password: string;
  bufferA: Buffer;
  bufferB: Buffer;
  legacyDomain: string;
}): Promise<void> {
  const ready = await requestJson({
    baseUrl: params.baseUrl,
    path: "/api/v1/health/ready",
    label: "readiness",
    expectedStatus: 200,
  });
  invariant(ready.status === "ok", "readiness did not report ok");

  const login = await requestJson({
    baseUrl: params.baseUrl,
    path: "/api/v1/admin/auth/login",
    label: "login",
    expectedStatus: 200,
    method: "POST",
    ...jsonBody({ username: params.username, password: params.password }),
  });
  const accessToken = stringField(
    asObject(login.tokens, "login tokens"),
    "accessToken",
    "access token",
  );

  const uploadSlug = `${params.identity.runId.replace(/_/g, "-")}-blob`;
  const upload = await requestJson({
    baseUrl: params.baseUrl,
    path: "/api/v1/admin/videos/upload-db",
    label: "DB_BLOB upload",
    expectedStatus: 201,
    method: "POST",
    accessToken,
    body: databaseForm({
      bytes: params.bufferA,
      filename: "gate3c1-a.mp4",
      title: `Gate 3C-1 video ${params.identity.runId}`,
      slug: uploadSlug,
    }),
  });
  params.state.uploadedVideoId = stringField(upload, "id", "uploaded video id");

  const persistedA = await params.prisma.videoAsset.findUnique({
    where: { id: params.state.uploadedVideoId },
    include: { binaryAsset: true },
  });
  invariant(
    persistedA?.sourceType === VideoSourceType.DB_BLOB,
    "source type is not DB_BLOB",
  );
  invariant(persistedA.binaryAsset !== null, "DB binary row was not created");
  invariant(
    Buffer.from(persistedA.binaryAsset.data).equals(params.bufferA),
    "persisted bytes do not match Buffer A",
  );
  invariant(
    persistedA.binaryAsset.sizeBytes === BigInt(params.bufferA.length),
    "persisted Buffer A size is wrong",
  );
  invariant(
    persistedA.binaryAsset.mimeType === "video/mp4",
    "persisted Buffer A MIME is wrong",
  );
  invariant(
    typeof persistedA.binaryAsset.checksumSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(persistedA.binaryAsset.checksumSha256) &&
      persistedA.binaryAsset.checksumSha256 ===
        computeSha256Hex(params.bufferA),
    "persisted Buffer A checksum is invalid",
  );
  const checksumA = persistedA.binaryAsset.checksumSha256;
  console.log(safeProofMessage("initial DB_BLOB bytes and checksum", "PROVEN"));

  await requestJson({
    baseUrl: params.baseUrl,
    path: `/api/v1/admin/websites/${params.identity.websiteId}/videos/assign`,
    label: "website-video assignment",
    expectedStatus: 201,
    method: "POST",
    accessToken,
    ...jsonBody({ videoId: params.state.uploadedVideoId }),
  });

  const created = await requestJson({
    baseUrl: params.baseUrl,
    path: `/api/v1/admin/websites/${params.identity.websiteId}/videos/${params.state.uploadedVideoId}/canonical-share-link`,
    label: "canonical creation",
    expectedStatus: 201,
    method: "POST",
    accessToken,
  });
  assertNoCanonicalCredentials(created);
  invariant(
    created.outcome === "CREATED",
    "initial canonical outcome is not CREATED",
  );
  const createdShareLink = asObject(
    created.shareLink,
    "created canonical shareLink",
  );
  params.state.canonicalShareLinkId = stringField(
    createdShareLink,
    "id",
    "canonical shareLink id",
  );
  const createdAlias = stringField(created, "alias", "canonical alias");
  const createdPublicUrl = stringField(
    created,
    "publicUrl",
    "canonical public URL",
  );
  const createdSnapshot = asObject(
    created.evidenceSnapshot,
    "canonical evidence snapshot",
  );
  invariant(
    createdSnapshot.checksumSha256 === checksumA,
    "canonical snapshot omitted DB checksum",
  );
  invariant(
    createdSnapshot.sizeBytes === String(params.bufferA.length),
    "canonical snapshot size is wrong",
  );
  invariant(
    createdSnapshot.mimeType === "video/mp4",
    "canonical snapshot MIME is wrong",
  );

  const canonicalRow = await params.prisma.canonicalVideoShareLink.findUnique({
    where: {
      websiteId_videoId: {
        websiteId: params.identity.websiteId,
        videoId: params.state.uploadedVideoId,
      },
    },
  });
  invariant(canonicalRow !== null, "canonical mapping was not persisted");
  const storedFingerprint = canonicalRow.evidenceFingerprint;
  const storedSnapshot = canonicalRow.evidenceSnapshotJson;
  const proofACounts = await Promise.all([
    params.prisma.shareLink.count({
      where: { websiteId: params.identity.websiteId },
    }),
    params.prisma.shareLinkVideo.count({
      where: { shareLinkId: params.state.canonicalShareLinkId },
    }),
    params.prisma.canonicalVideoShareLink.count({
      where: { websiteId: params.identity.websiteId },
    }),
    params.prisma.adminAuditLog.count({
      where: {
        adminId: params.identity.adminId,
        action: "CANONICAL_SHARE_LINK_CREATE",
        status: AuditStatus.SUCCESS,
      },
    }),
  ]);
  invariant(
    proofACounts.every((count) => count === 1),
    "Proof A write graph is not exactly 1/1/1/1",
  );
  console.log(safeProofMessage("initial canonical creation graph", "PROVEN"));

  const beforeReuse = await canonicalWriteCounts(params.prisma);
  const reused = await requestJson({
    baseUrl: params.baseUrl,
    path: `/api/v1/admin/websites/${params.identity.websiteId}/videos/${params.state.uploadedVideoId}/canonical-share-link`,
    label: "canonical unchanged-content reuse",
    expectedStatus: 201,
    method: "POST",
    accessToken,
  });
  assertNoCanonicalCredentials(reused);
  invariant(
    reused.outcome === "REUSED",
    "unchanged canonical outcome is not REUSED",
  );
  invariant(
    asObject(reused.shareLink, "reused shareLink").id ===
      params.state.canonicalShareLinkId,
    "reuse changed shareLink id",
  );
  invariant(reused.alias === createdAlias, "reuse changed alias");
  invariant(reused.publicUrl === createdPublicUrl, "reuse changed public URL");

  const current = await requestJson({
    baseUrl: params.baseUrl,
    path: `/api/v1/admin/websites/${params.identity.websiteId}/videos/${params.state.uploadedVideoId}/canonical-share-link`,
    label: "canonical GET before replacement",
    expectedStatus: 200,
    accessToken,
  });
  assertNoCanonicalCredentials(current);
  invariant(
    current.evidenceDrift === false,
    "unchanged canonical GET reported drift",
  );
  invariant(
    current.alias === createdAlias && current.publicUrl === createdPublicUrl,
    "canonical GET changed identity",
  );
  assertEqualRecord(
    beforeReuse,
    await canonicalWriteCounts(params.prisma),
    "unchanged-content reuse",
  );
  console.log(safeProofMessage("unchanged-content idempotent reuse", "PROVEN"));

  await requestJson({
    baseUrl: params.baseUrl,
    path: `/api/v1/admin/videos/${params.state.uploadedVideoId}/binary`,
    label: "equal-size binary replacement",
    expectedStatus: 200,
    method: "PATCH",
    accessToken,
    body: databaseForm({ bytes: params.bufferB, filename: "gate3c1-b.mp4" }),
  });
  const persistedB = await params.prisma.videoBinaryAsset.findUnique({
    where: { videoId: params.state.uploadedVideoId },
  });
  invariant(persistedB !== null, "replacement binary row is missing");
  invariant(
    Buffer.from(persistedB.data).equals(params.bufferB),
    "persisted bytes do not match Buffer B",
  );
  invariant(
    persistedB.sizeBytes === BigInt(params.bufferA.length),
    "replacement changed byte length",
  );
  invariant(persistedB.mimeType === "video/mp4", "replacement changed MIME");
  invariant(
    persistedB.checksumSha256 === computeSha256Hex(params.bufferB) &&
      persistedB.checksumSha256 !== checksumA,
    "replacement checksum did not track Buffer B",
  );

  const beforeDrift = await canonicalWriteCounts(params.prisma);
  const driftPost = await requestJson({
    baseUrl: params.baseUrl,
    path: `/api/v1/admin/websites/${params.identity.websiteId}/videos/${params.state.uploadedVideoId}/canonical-share-link`,
    label: "canonical POST after equal-size replacement",
    expectedStatus: 409,
    method: "POST",
    accessToken,
  });
  invariant(
    stableErrorCode(driftPost) === "CANONICAL_EVIDENCE_DRIFT",
    "replacement did not return CANONICAL_EVIDENCE_DRIFT",
  );
  const driftGet = await requestJson({
    baseUrl: params.baseUrl,
    path: `/api/v1/admin/websites/${params.identity.websiteId}/videos/${params.state.uploadedVideoId}/canonical-share-link`,
    label: "canonical GET after equal-size replacement",
    expectedStatus: 200,
    accessToken,
  });
  assertNoCanonicalCredentials(driftGet);
  invariant(
    driftGet.evidenceDrift === true,
    "canonical GET did not report evidenceDrift=true",
  );
  invariant(
    driftGet.alias === createdAlias && driftGet.publicUrl === createdPublicUrl,
    "drift GET changed canonical identity",
  );
  assertEqualRecord(
    beforeDrift,
    await canonicalWriteCounts(params.prisma),
    "equal-size drift rejection",
  );
  const unchangedCanonical =
    await params.prisma.canonicalVideoShareLink.findUniqueOrThrow({
      where: { shareLinkId: params.state.canonicalShareLinkId },
    });
  invariant(
    unchangedCanonical.evidenceFingerprint === storedFingerprint,
    "drift overwrote fingerprint",
  );
  invariant(
    JSON.stringify(unchangedCanonical.evidenceSnapshotJson) ===
      JSON.stringify(storedSnapshot),
    "drift overwrote snapshot",
  );
  console.log(
    safeProofMessage("equal-size/equal-MIME replacement drift", "PROVEN"),
  );

  await createLegacyNullFixture({
    prisma: params.prisma,
    identity: params.identity,
    domain: params.legacyDomain,
    bytes: params.bufferA,
  });
  const legacyFixtureCounts = await Promise.all([
    params.prisma.website.count({
      where: { id: params.identity.legacyWebsiteId },
    }),
    params.prisma.websiteDomain.count({
      where: { id: params.identity.legacyDomainId },
    }),
    params.prisma.videoAsset.count({
      where: { id: params.identity.legacyVideoId },
    }),
    params.prisma.videoBinaryAsset.count({
      where: { id: params.identity.legacyBinaryId, checksumSha256: null },
    }),
    params.prisma.websiteVideo.count({
      where: { id: params.identity.legacyAssignmentId },
    }),
    params.prisma.canonicalVideoShareLink.count({
      where: {
        websiteId: params.identity.legacyWebsiteId,
        videoId: params.identity.legacyVideoId,
      },
    }),
  ]);
  invariant(
    legacyFixtureCounts.slice(0, 5).every((count) => count === 1) &&
      legacyFixtureCounts[5] === 0,
    "legacy-null prerequisite graph is not exactly 1/1/1/1/1/0",
  );
  const nullWritesBefore = await canonicalWriteCounts(params.prisma);
  const incomplete = await requestJson({
    baseUrl: params.baseUrl,
    path: `/api/v1/admin/websites/${params.identity.legacyWebsiteId}/videos/${params.identity.legacyVideoId}/canonical-share-link`,
    label: "legacy-null canonical creation",
    expectedStatus: 409,
    method: "POST",
    accessToken,
  });
  invariant(
    stableErrorCode(incomplete) === "CANONICAL_EVIDENCE_INCOMPLETE",
    "legacy-null creation returned the wrong code",
  );
  assertEqualRecord(
    nullWritesBefore,
    await canonicalWriteCounts(params.prisma),
    "legacy-null canonical creation",
  );
  console.log(
    safeProofMessage("legacy-null canonical create zero-write", "PROVEN"),
  );

  const generic = await requestJson({
    baseUrl: params.baseUrl,
    path: `/api/v1/admin/websites/${params.identity.legacyWebsiteId}/share-links`,
    label: "generic legacy share-link creation",
    expectedStatus: 201,
    method: "POST",
    accessToken,
    ...jsonBody({ videoIds: [params.identity.legacyVideoId] }),
  });
  invariant(
    typeof generic.rawToken === "string" && generic.rawToken.length > 0,
    "generic legacy flow did not return its one-time token",
  );
  delete generic.rawToken;
  params.state.genericShareLinkId = stringField(
    asObject(generic.shareLink, "generic shareLink"),
    "id",
    "generic shareLink id",
  );
  const adoptionBefore = {
    canonical: await params.prisma.canonicalVideoShareLink.count(),
    adoptionAudits: await params.prisma.adminAuditLog.count({
      where: {
        adminId: params.identity.adminId,
        action: "CANONICAL_SHARE_LINK_ADOPT",
        status: AuditStatus.SUCCESS,
      },
    }),
    legacyLink: await params.prisma.shareLink.count({
      where: { id: params.state.genericShareLinkId },
    }),
    legacyRelation: await params.prisma.shareLinkVideo.count({
      where: { shareLinkId: params.state.genericShareLinkId },
    }),
  };
  let adoptionCode: string | null = null;
  try {
    await params.canonicalService.adoptExistingShareLink({
      websiteId: params.identity.legacyWebsiteId,
      videoId: params.identity.legacyVideoId,
      shareLinkId: params.state.genericShareLinkId,
      adminId: params.identity.adminId,
    });
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "getResponse" in error &&
      typeof error.getResponse === "function"
    ) {
      adoptionCode = stableErrorCode(error.getResponse());
    }
  }
  invariant(
    adoptionCode === "CANONICAL_EVIDENCE_INCOMPLETE",
    "legacy-null adoption was not refused safely",
  );
  const adoptionAfter = {
    canonical: await params.prisma.canonicalVideoShareLink.count(),
    adoptionAudits: await params.prisma.adminAuditLog.count({
      where: {
        adminId: params.identity.adminId,
        action: "CANONICAL_SHARE_LINK_ADOPT",
        status: AuditStatus.SUCCESS,
      },
    }),
    legacyLink: await params.prisma.shareLink.count({
      where: { id: params.state.genericShareLinkId },
    }),
    legacyRelation: await params.prisma.shareLinkVideo.count({
      where: { shareLinkId: params.state.genericShareLinkId },
    }),
  };
  assertEqualRecord(adoptionBefore, adoptionAfter, "legacy-null adoption");
  invariant(
    adoptionAfter.legacyLink === 1 && adoptionAfter.legacyRelation === 1,
    "adoption modified the legacy link",
  );
  console.log(safeProofMessage("legacy-null adoption zero-write", "PROVEN"));
}

async function cleanupFixtures(params: {
  prisma: PrismaClient;
  identity: Gate3c1FixtureIdentity;
  state: ProofState;
}): Promise<void> {
  const scope = buildGate3c1CleanupScope(params.identity);
  const uploadedBySlug = await params.prisma.videoAsset.findUnique({
    where: { slug: `${params.identity.runId.replace(/_/g, "-")}-blob` },
    select: { id: true },
  });
  const videoIds = Array.from(
    new Set(
      [
        params.state.uploadedVideoId,
        uploadedBySlug?.id ?? null,
        scope.legacyVideoId,
      ].filter((value): value is string => value !== null),
    ),
  );
  const runLinks = await params.prisma.shareLink.findMany({
    where: { websiteId: { in: [...scope.websiteIds] } },
    select: { id: true },
  });
  const shareLinkIds = runLinks.map((row) => row.id);

  await params.prisma.canonicalVideoShareLink.deleteMany({
    where: { websiteId: { in: [...scope.websiteIds] } },
  });
  if (shareLinkIds.length > 0) {
    await params.prisma.shareLinkVideo.deleteMany({
      where: { shareLinkId: { in: shareLinkIds } },
    });
    await params.prisma.shareLink.deleteMany({
      where: { id: { in: shareLinkIds } },
    });
  }
  await params.prisma.websiteVideo.deleteMany({
    where: { websiteId: { in: [...scope.websiteIds] } },
  });
  if (videoIds.length > 0) {
    await params.prisma.videoAsset.deleteMany({
      where: { id: { in: videoIds } },
    });
  }
  await params.prisma.websiteDomain.deleteMany({
    where: { id: { in: [...scope.domainIds] } },
  });
  await params.prisma.website.deleteMany({
    where: { id: { in: [...scope.websiteIds] } },
  });
  await params.prisma.adminAuditLog.deleteMany({
    where: { adminId: scope.adminId },
  });
  await params.prisma.adminRefreshToken.deleteMany({
    where: { adminId: scope.adminId },
  });
  await params.prisma.adminSession.deleteMany({
    where: { adminId: scope.adminId },
  });
  await params.prisma.adminUser.deleteMany({
    where: { id: scope.adminId },
  });

  const leftovers = await Promise.all([
    params.prisma.canonicalVideoShareLink.count({
      where: { websiteId: { in: [...scope.websiteIds] } },
    }),
    params.prisma.shareLink.count({
      where: { websiteId: { in: [...scope.websiteIds] } },
    }),
    params.prisma.shareLinkVideo.count({
      where: { shareLinkId: { in: shareLinkIds } },
    }),
    params.prisma.websiteVideo.count({
      where: { websiteId: { in: [...scope.websiteIds] } },
    }),
    params.prisma.videoAsset.count({ where: { id: { in: videoIds } } }),
    params.prisma.videoBinaryAsset.count({
      where: { videoId: { in: videoIds } },
    }),
    params.prisma.websiteDomain.count({
      where: { id: { in: [...scope.domainIds] } },
    }),
    params.prisma.website.count({
      where: { id: { in: [...scope.websiteIds] } },
    }),
    params.prisma.adminAuditLog.count({ where: { adminId: scope.adminId } }),
    params.prisma.adminUser.count({ where: { id: scope.adminId } }),
    params.prisma.adminSession.count({ where: { adminId: scope.adminId } }),
    params.prisma.adminRefreshToken.count({
      where: { adminId: scope.adminId },
    }),
  ]);
  invariant(
    leftovers.every((count) => count === 0),
    "cleanup left a run-scoped row",
  );
}

function createStandalonePrisma(database: string): PrismaClient {
  const rawUrl = process.env.DATABASE_URL?.trim().replace(/^"|"$/g, "");
  invariant(rawUrl, "DATABASE_URL is unavailable after guard");
  const url = new URL(rawUrl);
  return new PrismaClient({
    adapter: new PrismaMariaDb({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
      connectionLimit: 1,
      allowPublicKeyRetrieval: true,
    }),
  });
}

async function verifyNoProofConnections(database: string): Promise<void> {
  const verifier = createStandalonePrisma(database);
  try {
    const rows = await verifier.$queryRaw<
      { connectionCount: bigint | number | string }[]
    >(
      Prisma.sql`SELECT COUNT(*) AS connectionCount FROM information_schema.PROCESSLIST WHERE DB = ${database} AND ID <> CONNECTION_ID()`,
    );
    const count = Number(rows[0]?.connectionCount ?? -1);
    invariant(count === 0, "proof left an active test-database connection");
  } finally {
    await verifier.$disconnect();
  }
}

function safeFailureDescription(error: unknown): string {
  if (error instanceof ProofAssertionError) {
    return error.message;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `database request failed (${error.code})`;
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return "database initialization failed";
  }
  return error instanceof Error ? `${error.name} failed` : "unknown failure";
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  invariant(
    address !== null && typeof address === "object",
    "could not reserve a local API port",
  );
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function startTestApi(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [join(__dirname, "canonical-db-blob-evidence-proof-api.cjs")],
    {
      cwd: join(__dirname, "../.."),
      env: {
        ...process.env,
        APP_ENV: "test",
        DOTENV_CONFIG_PATH: ".env.test",
        GATE3C1_API_PORT: String(port),
        VIDEO_DB_STORAGE_ENABLED: "true",
        API_INTERNAL_DOCS_ENABLED: "false",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const deadline = Date.now() + 15_000;
    const check = async (): Promise<void> => {
      if (settled) return;
      if (child.exitCode !== null) {
        settled = true;
        reject(new ProofAssertionError("test API exited before readiness"));
        return;
      }
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/v1/health/ready`,
        );
        if (response.status === 200) {
          settled = true;
          resolve();
          return;
        }
      } catch {
        // The listener is still starting; retry until the bounded deadline.
      }
      if (Date.now() >= deadline) {
        settled = true;
        reject(new ProofAssertionError("test API readiness timed out"));
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
  return child;
}

async function stopTestApi(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function createCompiledAdoptionService(
  prisma: PrismaClient,
): CanonicalAdoptionService {
  const { AdminWebsitesService } =
    require("../../dist/admin-websites/admin-websites.service.js") as {
      AdminWebsitesService: new (...args: unknown[]) => object;
    };
  const { CanonicalShareLinkService: CompiledCanonicalShareLinkService } =
    require("../../dist/admin-websites/canonical-share-link.service.js") as {
      CanonicalShareLinkService: new (
        ...args: unknown[]
      ) => CanonicalAdoptionService;
    };
  const configStub = {
    get: (key: string): string | undefined => process.env[key],
    getOrThrow: (key: string): string => {
      const value = process.env[key];
      invariant(value !== undefined, `required test config ${key} is absent`);
      return value;
    },
  };
  const websitesService = new AdminWebsitesService(
    prisma,
    configStub,
    { clearDomainOriginCache: () => undefined },
    undefined,
  );
  return new CompiledCanonicalShareLinkService(
    prisma,
    configStub,
    websitesService,
  );
}

async function main(): Promise<void> {
  loadApiEnv();
  const guarded = assertDestructiveTestDatabase();
  assertGate3c1Database(guarded.database);
  console.log(`Guard passed: ${guarded.host}/${guarded.database}`);

  // Gate-specific runtime enablement is set only after the guard and before
  // AppModule/config evaluation. No shared env file or database is modified.
  process.env.VIDEO_DB_STORAGE_ENABLED = "true";
  process.env.API_INTERNAL_DOCS_ENABLED = "false";

  const runId = `gate3c1_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const identity = buildGate3c1FixtureIdentity(runId);
  const state: ProofState = {
    uploadedVideoId: null,
    canonicalShareLinkId: null,
    genericShareLinkId: null,
  };
  const username = `g3c1_${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");
  const domainStem = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  const domain = `g3c1-${domainStem}.example.test`;
  const legacyDomain = `g3c1-legacy-${domainStem}.example.test`;
  const { bufferA, bufferB } = createProofBuffers();

  let apiProcess: ChildProcess | null = null;
  let prisma: PrismaClient | null = null;
  let initialCounts: DatabaseCounts | null = null;
  const failures: unknown[] = [];

  try {
    prisma = createStandalonePrisma(guarded.database);
    await verifyMigrations(prisma);
    initialCounts = await countDatabase(prisma);
    console.log(`Migrations verified: 19; run=${runId}`);
    console.log(`Initial isolated counts: ${JSON.stringify(initialCounts)}`);

    await setupBaseFixtures({
      prisma,
      identity,
      username,
      password,
      domain,
    });
    const baseCounts = await Promise.all([
      prisma.adminUser.count({ where: { id: identity.adminId } }),
      prisma.website.count({ where: { id: identity.websiteId } }),
      prisma.websiteDomain.count({ where: { id: identity.domainId } }),
    ]);
    invariant(
      baseCounts.every((count) => count === 1),
      "base fixture graph is incomplete",
    );

    const port = await reserveLocalPort();
    apiProcess = await startTestApi(port);
    const baseUrl = `http://127.0.0.1:${port}`;
    await runHttpProof({
      prisma,
      canonicalService: createCompiledAdoptionService(prisma),
      identity,
      state,
      baseUrl,
      username,
      password,
      bufferA,
      bufferB,
      legacyDomain,
    });
  } catch (error) {
    failures.push(error);
  } finally {
    if (prisma !== null) {
      try {
        await cleanupFixtures({ prisma, identity, state });
        if (initialCounts !== null) {
          const finalCounts = await countDatabase(prisma);
          assertSameCounts(initialCounts, finalCounts, "post-cleanup database");
          console.log(`Final isolated counts: ${JSON.stringify(finalCounts)}`);
        }
        console.log(
          safeProofMessage("zero run-scoped fixture leftovers", "PROVEN"),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (apiProcess !== null) {
      try {
        await stopTestApi(apiProcess);
      } catch (error) {
        failures.push(error);
      }
    }
    if (prisma !== null) {
      try {
        await prisma.$disconnect();
      } catch (error) {
        failures.push(error);
      }
    }
  }

  try {
    await verifyNoProofConnections(guarded.database);
    console.log(
      safeProofMessage("no proof-owned database connections", "PROVEN"),
    );
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL: ${safeFailureDescription(failure)}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("GATE 3C-1 CANONICAL DB_BLOB EVIDENCE PROOF PASSED");
}

void main();
