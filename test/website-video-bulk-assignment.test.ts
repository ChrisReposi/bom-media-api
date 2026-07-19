import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { ADMIN_ROLES_METADATA } from "../src/admin-auth/decorators/admin-roles.decorator";
import { AdminWebsitesController } from "../src/admin-websites/admin-websites.controller";
import { AdminWebsitesService } from "../src/admin-websites/admin-websites.service";
import {
  AdminRole,
  AssignmentStatus,
  AuditStatus,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
} from "../src/generated/prisma/client";

const now = new Date("2026-07-19T00:00:00.000Z");

function video(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: `Video ${id}`,
    slug: id,
    description: null,
    provider: VideoProvider.MANUAL,
    sourceType: VideoSourceType.DIRECT_URL,
    providerAssetId: null,
    playbackId: null,
    playbackUrl: `https://media.example/${id}.mp4`,
    embedProvider: null,
    embedUrl: null,
    embedCloudName: null,
    embedPublicId: null,
    embedAllow: null,
    thumbnailUrl: null,
    durationSeconds: 30,
    viewCount: 0n,
    publishedAt: null,
    status: VideoStatus.READY,
    filterKey: null,
    metadataJson: null,
    binaryAsset: null,
    localFileAsset: null,
    localThumbnailAsset: null,
    websiteVideos: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function service(prisma: unknown): AdminWebsitesService {
  return new AdminWebsitesService(
    prisma as never,
    { get: () => "test-share-pepper" } as never,
    { clearDomainOriginCache: () => undefined } as never,
  );
}

function readBadRequest(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof BadRequestException)) return null;
  const response = error.getResponse();
  return typeof response === "object" && response !== null
    ? (response as Record<string, unknown>)
    : null;
}

describe("website video assignment options", () => {
  it("allows every admin role to read options but only OWNER/ADMIN to mutate", () => {
    assert.deepEqual(
      Reflect.getMetadata(
        ADMIN_ROLES_METADATA,
        AdminWebsitesController.prototype.listVideoAssignmentOptions,
      ),
      [AdminRole.OWNER, AdminRole.ADMIN, AdminRole.STAFF],
    );
    assert.deepEqual(
      Reflect.getMetadata(
        ADMIN_ROLES_METADATA,
        AdminWebsitesController.prototype.updateVideoAssignments,
      ),
      [AdminRole.OWNER, AdminRole.ADMIN],
    );
  });

  it("lists authoritative assigned state plus eligible unassigned candidates", async () => {
    let optionFindArgs: Record<string, unknown> | null = null;
    let countCall = 0;
    const prisma = {
      website: { findUnique: async () => ({ id: "website-1" }) },
      websiteVideo: {
        findMany: async () => [
          { videoId: "assigned-not-ready" },
          { videoId: "assigned-on-another-page" },
        ],
      },
      videoAsset: {
        count: async () => {
          countCall += 1;
          return countCall === 1 ? 2 : 1;
        },
        findMany: async (args: Record<string, unknown>) => {
          optionFindArgs = args;
          return [
            video("assigned-not-ready", {
              status: VideoStatus.DISABLED,
              playbackUrl: null,
              websiteVideos: [
                { id: "assignment-1", status: AssignmentStatus.ACTIVE },
              ],
            }),
            video("eligible-candidate", {
              websiteVideos: [
                { id: "assignment-2", status: AssignmentStatus.DISABLED },
              ],
            }),
          ];
        },
      },
      $transaction: async (operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
    };

    const result = await service(prisma).listVideoAssignmentOptions(
      "website-1",
      {
        page: 2,
        limit: 10,
        search: "video",
        sortBy: "title",
        sortOrder: "asc",
      },
    );

    assert.equal(result.items[0]?.isAssigned, true);
    assert.equal(result.items[0]?.canUnassign, true);
    assert.equal(result.items[0]?.canAssign, false);
    assert.equal(result.items[0]?.blockedReason, "VIDEO_NOT_READY");
    assert.equal(result.items[1]?.isAssigned, false);
    assert.equal(result.items[1]?.assignmentStatus, AssignmentStatus.DISABLED);
    assert.equal(result.items[1]?.canAssign, true);
    assert.deepEqual(result.meta.activeAssignedVideoIds, [
      "assigned-not-ready",
      "assigned-on-another-page",
    ]);
    assert.equal(result.meta.activeAssignmentTotal, 2);
    assert.equal(result.meta.eligibleCandidateTotal, 1);
    assert.equal(optionFindArgs?.skip, 10);
    assert.equal(optionFindArgs?.take, 10);
    assert.deepEqual(optionFindArgs?.orderBy, [
      { title: "asc" },
      { id: "asc" },
    ]);
    assert.match(JSON.stringify(optionFindArgs?.where), /website-1/);
  });
});

type Assignment = {
  id: string;
  videoId: string;
  status: AssignmentStatus;
  sortOrder: number;
  isFeatured: boolean;
};

function bulkHarness(options?: { missingVideoIds?: string[] }) {
  const assignments = new Map<string, Assignment>([
    [
      "active-video",
      {
        id: "assignment-active",
        videoId: "active-video",
        status: AssignmentStatus.ACTIVE,
        sortOrder: 0,
        isFeatured: true,
      },
    ],
    [
      "disabled-video",
      {
        id: "assignment-disabled",
        videoId: "disabled-video",
        status: AssignmentStatus.DISABLED,
        sortOrder: 1,
        isFeatured: false,
      },
    ],
    [
      "active-video-2",
      {
        id: "assignment-active-2",
        videoId: "active-video-2",
        status: AssignmentStatus.ACTIVE,
        sortOrder: 2,
        isFeatured: false,
      },
    ],
  ]);
  const writes: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let canonicalMappingCount = 1;
  const tx = {
    website: {
      findUnique: async () => ({
        id: "website-1",
        status: WebsiteStatus.ACTIVE,
      }),
    },
    videoAsset: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in
          .filter((id) => !(options?.missingVideoIds ?? []).includes(id))
          .map((id) => video(id)),
    },
    websiteVideo: {
      findMany: async ({ where }: { where: { videoId: { in: string[] } } }) =>
        where.videoId.in
          .map((id) => assignments.get(id))
          .filter((assignment): assignment is Assignment =>
            Boolean(assignment),
          ),
      aggregate: async () => ({
        _max: {
          sortOrder: Math.max(
            ...[...assignments.values()].map(
              (assignment) => assignment.sortOrder,
            ),
          ),
        },
      }),
      upsert: async ({
        where,
        create,
      }: {
        where: { websiteId_videoId: { videoId: string } };
        create: Assignment;
      }) => {
        const id = where.websiteId_videoId.videoId;
        const existing = assignments.get(id);
        writes.push(`assign:${id}`);
        assignments.set(id, {
          id: existing?.id ?? `assignment-${id}`,
          videoId: id,
          status: AssignmentStatus.ACTIVE,
          sortOrder: existing?.sortOrder ?? create.sortOrder,
          isFeatured: existing?.isFeatured ?? false,
        });
        return assignments.get(id);
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { status: AssignmentStatus; isFeatured: boolean };
      }) => {
        const existing = [...assignments.values()].find(
          (assignment) => assignment.id === where.id,
        );
        assert.ok(existing);
        writes.push(`unassign:${existing.videoId}`);
        assignments.set(existing.videoId, { ...existing, ...data });
        return assignments.get(existing.videoId);
      },
      count: async () =>
        [...assignments.values()].filter(
          (assignment) => assignment.status === AssignmentStatus.ACTIVE,
        ).length,
    },
    adminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return { id: `audit-${audits.length}` };
      },
    },
    canonicalVideoShareLink: {
      deleteMany: async () => {
        canonicalMappingCount = 0;
        throw new Error("canonical mappings must never be changed");
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback(tx),
  };

  return {
    service: service(prisma),
    assignments,
    writes,
    audits,
    canonicalMappingCount: () => canonicalMappingCount,
  };
}

describe("atomic website video assignment update", () => {
  it("assigns, reactivates and unassigns multiple videos in one transaction", async () => {
    const harness = bulkHarness();
    const result = await harness.service.updateVideoAssignments(
      "website-1",
      {
        assignVideoIds: ["disabled-video", "new-video"],
        unassignVideoIds: ["active-video", "active-video-2"],
      },
      "admin-1",
    );

    assert.deepEqual(result, {
      assignedVideoIds: ["disabled-video", "new-video"],
      unassignedVideoIds: ["active-video", "active-video-2"],
      unchangedVideoIds: [],
      activeAssignmentTotal: 2,
    });
    assert.equal(
      harness.assignments.get("disabled-video")?.status,
      AssignmentStatus.ACTIVE,
    );
    assert.equal(
      harness.assignments.get("active-video")?.status,
      AssignmentStatus.DISABLED,
    );
    assert.equal(harness.assignments.get("active-video")?.isFeatured, false);
    assert.equal(harness.audits.length, 1);
    assert.equal(harness.audits[0]?.status, AuditStatus.SUCCESS);
    assert.equal(harness.canonicalMappingCount(), 1);
  });

  it("is idempotent when the same desired deltas are repeated", async () => {
    const harness = bulkHarness();
    const request = {
      assignVideoIds: ["disabled-video"],
      unassignVideoIds: ["active-video"],
    };

    await harness.service.updateVideoAssignments(
      "website-1",
      request,
      "admin-1",
    );
    const repeated = await harness.service.updateVideoAssignments(
      "website-1",
      request,
      "admin-1",
    );

    assert.deepEqual(repeated.assignedVideoIds, []);
    assert.deepEqual(repeated.unassignedVideoIds, []);
    assert.deepEqual(repeated.unchangedVideoIds, [
      "disabled-video",
      "active-video",
    ]);
    assert.deepEqual(harness.writes, [
      "assign:disabled-video",
      "unassign:active-video",
    ]);
  });

  it("rejects overlap before opening a transaction", async () => {
    const harness = bulkHarness();

    await assert.rejects(
      harness.service.updateVideoAssignments(
        "website-1",
        {
          assignVideoIds: ["same-video"],
          unassignVideoIds: ["same-video"],
        },
        "admin-1",
      ),
      (error: unknown) =>
        readBadRequest(error)?.code === "WEBSITE_VIDEO_ASSIGNMENT_OVERLAP",
    );
    assert.deepEqual(harness.writes, []);
    assert.equal(harness.audits.length, 0);
  });

  it("normalizes duplicate IDs and rejects any missing video before writes", async () => {
    const harness = bulkHarness({ missingVideoIds: ["missing-video"] });

    await assert.rejects(
      harness.service.updateVideoAssignments(
        "website-1",
        {
          assignVideoIds: [" new-video ", "new-video", "missing-video"],
          unassignVideoIds: [],
        },
        "admin-1",
      ),
      (error: unknown) => {
        const response = readBadRequest(error);
        assert.equal(
          response?.code,
          "WEBSITE_VIDEO_ASSIGNMENT_VIDEO_NOT_FOUND",
        );
        assert.deepEqual(
          (response?.details as { invalidVideoIds: string[] })?.invalidVideoIds,
          ["missing-video"],
        );
        return true;
      },
    );
    assert.deepEqual(harness.writes, []);
    assert.equal(harness.audits.length, 0);
  });
});
