/**
 * Shared fixtures for the SHARE-LINK BACKWARD COMPATIBILITY suite
 * (`test/share-link-compat-*.test.ts`).
 *
 * Contract: `project-docs/SHARE_LINK_COMPATIBILITY.md`
 * Manifest: `docs/SHARE_LINK_COMPATIBILITY_TESTS.md`
 *
 * These fakes exist to lock in the CURRENT, source-verified behaviour of
 * existing production share links. Three rules keep them honest:
 *
 * 1. **No production logic is reimplemented here.** The fake Prisma client
 *    applies the filters, ordering and limits that the services *ask for* in
 *    their own query arguments (`include.shareLinkVideos.where`, `orderBy`,
 *    `take`, `where.currentViews.lt`, ...). If a change drops one of those
 *    clauses, the fake stops filtering too and the compatibility test fails -
 *    which is the point.
 * 2. **Behaviour over introspection.** Prefer proving a property by what the
 *    system returns (denied / served / which bytes) over inspecting query
 *    objects or cache internals.
 * 3. **No production data.** Every token, alias, host and id below is
 *    synthetic and deterministic. Nothing here opens a database connection.
 */
import "reflect-metadata";
import { Readable } from "node:stream";
import { AdminWebsitesService } from "../src/admin-websites/admin-websites.service";
import { VideosService } from "../src/videos/videos.service";
import {
  AccessLogStatus,
  AssignmentStatus,
  DomainStatus,
  EmbedProvider,
  ShareLinkStatus,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
} from "../src/generated/prisma/client";
import { MemoryCacheService } from "../src/cache/memory-cache.service";
import type { MemoryCacheRuntimeConfig } from "../src/cache/memory-cache.types";
import { PublicMediaGrantService } from "../src/public/public-media-grant.service";
import { PublicService } from "../src/public/public.service";

/* ------------------------------------------------------------------ *
 * Independent legacy credential fixture (COMPAT-001)
 *
 * The expected digest below is an IMMUTABLE LITERAL. It was computed outside
 * this codebase, with a different SHA-256 implementation (Python `hashlib`),
 * over the exact byte sequence `pepper || token`:
 *
 *     python -c "import hashlib; print(hashlib.sha256(
 *         (PEPPER + TOKEN).encode('utf-8')).hexdigest())"
 *
 * It is deliberately NOT derived from `hashShareToken()`, so the test compares
 * the production function against an independent expectation rather than
 * against itself. Changing the concatenation order, the encoding, the digest
 * algorithm, or any normalisation of either input changes the output and fails
 * the test.
 *
 * All three values are synthetic. No production token or pepper appears here.
 * ------------------------------------------------------------------ */

/** Synthetic, shaped exactly like `generateShareToken()` output. */
export const LEGACY_RAW_TOKEN = "s_Ym9tLW1lZGlhLWNvbXBhdC1maXh0dXJlLXRva2VuISE";

/** Synthetic pepper. Never a production value. */
export const LEGACY_TOKEN_PEPPER =
  "compat-suite-share-token-pepper-0123456789abcdef";

/** Independently computed: sha256(LEGACY_TOKEN_PEPPER || LEGACY_RAW_TOKEN). */
export const LEGACY_EXPECTED_TOKEN_HASH =
  "ca3b94c6e03a9b4158c939fed9bcbb5ab616d0c9165059564ffbae58eed931eb";

/**
 * Independently computed: sha256(LEGACY_RAW_TOKEN || LEGACY_TOKEN_PEPPER) -
 * the reversed concatenation. Used as a negative expectation so that swapping
 * the operands cannot pass unnoticed.
 */
export const REVERSED_CONCATENATION_HASH =
  "ba468a1735f8c15f52647917644f2f2b70d91292499379ede6cfb391c046b6c6";

/* ---- Non-ASCII encoding vectors -------------------------------------------
 *
 * `SHARE_TOKEN_PEPPER` is an environment variable, so it may legitimately hold
 * arbitrary UTF-8. These vectors pin how `hashShareToken()` encodes it. Every
 * digest below was computed independently, with Python `hashlib`, over the
 * UTF-8 bytes of `pepper || token`.
 *
 * Share TOKENS are deliberately NOT covered by these vectors:
 * `generateShareToken()` emits `s_` + base64url, which is ASCII by
 * construction, so a non-ASCII token would assert a format production never
 * produces.
 * -------------------------------------------------------------------------- */

/** Synthetic non-ASCII pepper: 40 code points, 47 UTF-8 bytes. */
export const UNICODE_TOKEN_PEPPER =
  "compat-suite-pepper-\u00fcn\u00efc\u00f6d\u00e9-\u{1F511}-0123456789";

/** Independently computed: sha256(UNICODE_TOKEN_PEPPER || LEGACY_RAW_TOKEN). */
export const UNICODE_EXPECTED_TOKEN_HASH =
  "c55f03fd43fc9f6ff17331b0b25673a24d4396b0fdbafdea26456125cfb887c9";

/**
 * The same visual pepper in both Unicode normalisation forms. They are
 * different byte sequences and `hashShareToken()` applies no normalisation, so
 * they must produce different digests. Both computed independently.
 */
export const NFC_TOKEN_PEPPER = "compat-suite-pepper-caf\u00e9";
export const NFD_TOKEN_PEPPER = "compat-suite-pepper-cafe\u0301";

export const NFC_EXPECTED_TOKEN_HASH =
  "0b36320cf78676b018da6e30e645b7ba5dce9d5044b43050669cff5b78257515";
export const NFD_EXPECTED_TOKEN_HASH =
  "27f7cec8570923f3b866d84b83d95b076502c88172785a88dcff34f1f4330cad";

/** A second synthetic legacy token, for multi-share scenarios. */
export const SECOND_RAW_TOKEN = "s_Ym9tLW1lZGlhLWNvbXBhdC1zZWNvbmQtdG9rZW4hISE";

/** Independently computed: sha256(LEGACY_TOKEN_PEPPER || SECOND_RAW_TOKEN). */
export const SECOND_EXPECTED_TOKEN_HASH =
  "1b604c6d9d64b5e105a29a249deb66db99edd1880e5fadcec6219a843d4e718e";

/** Backwards-compatible alias used across the suites. */
export const TOKEN_PEPPER = LEGACY_TOKEN_PEPPER;

export const ROTATED_TOKEN_PEPPER =
  "compat-suite-rotated-share-token-pepper-0123456789";

/** Shaped like `generateShareAlias()` output (base64url of 5 bytes). */
export const LEGACY_ALIAS = "Ab3dEf7";
export const SECOND_ALIAS = "Zy9wQr2";

export const LEGACY_HOST = "customer.example.com";
export const SECOND_LEGACY_HOST = "www.customer.example.com";
export const FOREIGN_HOST = "other-tenant.example.com";
export const UNKNOWN_HOST = "not-a-customer.example.com";

export const WEBSITE_ID = "website-compat-a";
export const FOREIGN_WEBSITE_ID = "website-compat-b";
export const SHARE_LINK_ID = "share-link-compat-1";
export const SECOND_SHARE_LINK_ID = "share-link-compat-2";

/** The one body every public denial must return. */
export const PUBLIC_DENIAL_RESPONSE = Object.freeze({
  valid: false,
  reasonCode: "INVALID_LINK",
  website: null,
  videos: [],
});

const MEMORY_CACHE_CONFIG: MemoryCacheRuntimeConfig = {
  enabled: true,
  maxEntries: 1000,
  defaultTtlSeconds: 60,
  inflightTtlMs: 5000,
  adminVideosListTtlSeconds: 30,
  adminWebsitesListTtlSeconds: 60,
  publicWatchMetadataTtlSeconds: 10,
  mediaMetadataTtlSeconds: 300,
};

const FIXTURE_DATE = new Date("2026-01-15T00:00:00.000Z");

/* ------------------------------------------------------------------ *
 * Fixture shapes
 * ------------------------------------------------------------------ */

export type CompatAssetMetadata = {
  storageKey: string;
  mimeType: string;
  sizeBytes: bigint;
};

export type CompatVideo = {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  /**
   * Recorded for documentation value only. The public watch response keys off
   * `sourceType`; `provider` is never read by `PublicService`.
   */
  provider: VideoProvider;
  sourceType: VideoSourceType;
  playbackUrl: string | null;
  embedUrl: string | null;
  embedProvider: EmbedProvider | null;
  embedAllow: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: bigint;
  publishedAt: Date | null;
  status: VideoStatus;
  binaryAsset: Omit<CompatAssetMetadata, "storageKey"> | null;
  localFileAsset: CompatAssetMetadata | null;
  localThumbnailAsset: CompatAssetMetadata | null;
  websiteVideos: Array<{
    id: string;
    websiteId: string;
    videoId: string;
    status: AssignmentStatus;
    sortOrder: number;
  }>;
  createdAt: Date;
  updatedAt: Date;
};

export type CompatShareLinkVideoRow = {
  id: string;
  sortOrder: number;
  videoId: string;
};

export type CompatShareLink = {
  id: string;
  websiteId: string;
  tokenHash: string;
  alias: string | null;
  label: string | null;
  status: ShareLinkStatus;
  expiresAt: Date | null;
  maxViews: number | null;
  currentViews: number;
  lastViewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Physical row order, deliberately independent of `sortOrder`. */
  shareLinkVideos: CompatShareLinkVideoRow[];
};

export type CompatWebsite = {
  id: string;
  name: string;
  slug: string;
  status: WebsiteStatus;
};

export type CompatDomain = {
  id: string;
  domain: string;
  status: DomainStatus;
  websiteId: string;
};

/* ------------------------------------------------------------------ *
 * Video fixtures - one per legacy source type / provider shape
 * ------------------------------------------------------------------ */

export function assignedTo(
  ...websiteIds: string[]
): CompatVideo["websiteVideos"] {
  return websiteIds.map((websiteId, index) => ({
    id: `assignment-${websiteId}-${index}`,
    websiteId,
    videoId: "",
    status: AssignmentStatus.ACTIVE,
    sortOrder: index,
  }));
}

function baseVideo(overrides: Partial<CompatVideo> = {}): CompatVideo {
  const video: CompatVideo = {
    id: "video-compat-1",
    title: "Legacy shared video",
    slug: "legacy-shared-video",
    description: null,
    provider: VideoProvider.MANUAL,
    sourceType: VideoSourceType.DIRECT_URL,
    playbackUrl: "https://media.example.com/legacy/video.mp4",
    embedUrl: null,
    embedProvider: null,
    embedAllow: null,
    thumbnailUrl: "https://media.example.com/legacy/thumb.jpg",
    durationSeconds: 42,
    viewCount: 1234n,
    publishedAt: FIXTURE_DATE,
    status: VideoStatus.READY,
    binaryAsset: null,
    localFileAsset: null,
    localThumbnailAsset: null,
    websiteVideos: assignedTo(WEBSITE_ID),
    createdAt: FIXTURE_DATE,
    updatedAt: FIXTURE_DATE,
    ...overrides,
  };

  // Keep assignment rows self-consistent with the video they belong to.
  video.websiteVideos = video.websiteVideos.map((assignment) => ({
    ...assignment,
    videoId: video.id,
    id: `assignment-${video.id}-${assignment.websiteId}`,
  }));

  return video;
}

export function directUrlVideo(
  overrides: Partial<CompatVideo> = {},
): CompatVideo {
  return baseVideo({ id: "video-direct-url", ...overrides });
}

export function embedVideo(overrides: Partial<CompatVideo> = {}): CompatVideo {
  return baseVideo({
    id: "video-embed",
    sourceType: VideoSourceType.EMBED,
    playbackUrl: null,
    embedUrl: "https://www.youtube-nocookie.com/embed/legacyEmbedId",
    embedProvider: EmbedProvider.YOUTUBE_NOCOOKIE,
    embedAllow:
      "accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture",
    thumbnailUrl: "https://i.ytimg.com/vi/legacyEmbedId/hqdefault.jpg",
    ...overrides,
  });
}

export function localFileVideo(
  overrides: Partial<CompatVideo> = {},
): CompatVideo {
  const id = overrides.id ?? "video-local-file";

  return baseVideo({
    id,
    sourceType: VideoSourceType.LOCAL_FILE,
    // Legacy rows carry admin-only URLs in these columns. The public response
    // must never surface them - see `toSafePublicMediaUrl()`.
    playbackUrl: `/api/v1/admin/videos/${id}/local-file`,
    thumbnailUrl: `/api/v1/admin/videos/${id}/thumbnail`,
    localFileAsset: {
      storageKey: `videos/${id}/source/video.mp4`,
      mimeType: "video/mp4",
      sizeBytes: 10n,
    },
    localThumbnailAsset: {
      storageKey: `videos/${id}/thumbnails/thumb.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 4n,
    },
    ...overrides,
  });
}

export function dbBlobVideo(overrides: Partial<CompatVideo> = {}): CompatVideo {
  const id = overrides.id ?? "video-db-blob";

  return baseVideo({
    id,
    sourceType: VideoSourceType.DB_BLOB,
    playbackUrl: `/api/v1/admin/videos/${id}/binary`,
    thumbnailUrl: "https://media.example.com/legacy/db-thumb.jpg",
    binaryAsset: { mimeType: "video/mp4", sizeBytes: 10n },
    ...overrides,
  });
}

/**
 * Cloudinary upload: `provider=CLOUDINARY`, `sourceType=UPLOAD`,
 * `playbackUrl` = the unsigned Cloudinary `secure_url`.
 */
export function cloudinaryUploadVideo(
  overrides: Partial<CompatVideo> = {},
): CompatVideo {
  return baseVideo({
    id: "video-cloudinary-upload",
    provider: VideoProvider.CLOUDINARY,
    sourceType: VideoSourceType.UPLOAD,
    playbackUrl:
      "https://res.cloudinary.com/demo-cloud/video/upload/v1700000000/legacy/asset.mp4",
    thumbnailUrl:
      "https://res.cloudinary.com/demo-cloud/video/upload/so_0/v1700000000/legacy/asset.jpg",
    ...overrides,
  });
}

/**
 * Cloudinary direct URL: `resolveProvider()` tags any `DIRECT_URL` whose
 * playback host ends with `cloudinary.com` as `provider=CLOUDINARY`.
 */
export function cloudinaryDirectUrlVideo(
  overrides: Partial<CompatVideo> = {},
): CompatVideo {
  return baseVideo({
    id: "video-cloudinary-direct",
    provider: VideoProvider.CLOUDINARY,
    sourceType: VideoSourceType.DIRECT_URL,
    playbackUrl:
      "https://res.cloudinary.com/demo-cloud/video/upload/v1700000001/legacy/direct.mp4",
    ...overrides,
  });
}

/**
 * Cloudinary player embed: `provider=CLOUDINARY`, `sourceType=EMBED`,
 * `embedProvider=CLOUDINARY_PLAYER`.
 */
export function cloudinaryEmbedVideo(
  overrides: Partial<CompatVideo> = {},
): CompatVideo {
  return baseVideo({
    id: "video-cloudinary-embed",
    provider: VideoProvider.CLOUDINARY,
    sourceType: VideoSourceType.EMBED,
    playbackUrl: null,
    embedUrl:
      "https://player.cloudinary.com/embed/?cloud_name=demo-cloud&public_id=legacy%2Fasset",
    embedProvider: EmbedProvider.CLOUDINARY_PLAYER,
    embedAllow: "autoplay; fullscreen; encrypted-media; picture-in-picture",
    thumbnailUrl:
      "https://res.cloudinary.com/demo-cloud/video/upload/so_0/legacy/asset.jpg",
    ...overrides,
  });
}

/* ------------------------------------------------------------------ *
 * Fake Prisma client
 * ------------------------------------------------------------------ */

type SelectSpec = Record<string, boolean> | undefined;

function applySelect<T extends object>(
  value: T | null,
  select: SelectSpec,
): Partial<T> | null {
  if (value === null) {
    return null;
  }

  if (select === undefined) {
    return value;
  }

  const projected: Record<string, unknown> = {};
  for (const [field, enabled] of Object.entries(select)) {
    if (enabled) {
      projected[field] = (value as Record<string, unknown>)[field];
    }
  }

  return projected as Partial<T>;
}

type ShareLinkVideosQuery = {
  where?: {
    videoId?: string;
    video?: {
      websiteVideos?: {
        some?: { websiteId?: string; status?: AssignmentStatus };
      };
    };
  };
  orderBy?: { sortOrder?: "asc" | "desc" };
  take?: number;
  include?: {
    video?:
      | boolean
      | {
          include?: {
            binaryAsset?: { select?: Record<string, boolean> };
            localFileAsset?: { select?: Record<string, boolean> };
            localThumbnailAsset?: { select?: Record<string, boolean> };
          };
        };
  };
};

export type ShareLinkUpdateWhere = {
  /** View-consumption form: one link, targeted by id. */
  id?: string;
  status?: ShareLinkStatus;
  OR?: Array<{ expiresAt: null | { gt: Date } }>;
  currentViews?: { lt: number };
  /** Bulk form: every link whose membership contains this video. */
  shareLinkVideos?: { some?: { videoId?: string } };
};

function matchesUpdateWhere(
  record: CompatShareLink,
  where: ShareLinkUpdateWhere,
): boolean {
  if (where.status !== undefined && record.status !== where.status) {
    return false;
  }

  if (where.OR !== undefined) {
    const expiryOk = where.OR.some((clause) => {
      if (clause.expiresAt === null) {
        return record.expiresAt === null;
      }

      return (
        record.expiresAt !== null &&
        record.expiresAt.getTime() > clause.expiresAt.gt.getTime()
      );
    });

    if (!expiryOk) {
      return false;
    }
  }

  if (
    where.currentViews?.lt !== undefined &&
    record.currentViews >= where.currentViews.lt
  ) {
    return false;
  }

  return true;
}

export class CompatPrismaService {
  readonly websites: CompatWebsite[];
  readonly domains: CompatDomain[];
  /** Every video that exists globally, share member or not. */
  readonly videos: CompatVideo[];
  readonly shareLinks: CompatShareLink[];
  /** videoId to raw DB_BLOB bytes, read through the `$queryRaw` SUBSTRING. */
  readonly binaries = new Map<string, Buffer>();
  readonly accessLogs: Array<{
    status: AccessLogStatus;
    reasonCode: string;
    domain?: string;
    websiteId?: string;
    shareLinkId?: string;
  }> = [];
  readonly auditLogs: Array<{ action: string; entityId: string }> = [];

  readonly counters = {
    websiteDomainFindUnique: 0,
    shareLinkFindFirst: 0,
    shareLinkFindUnique: 0,
    shareLinkUpdateMany: 0,
    queryRaw: 0,
  };

  constructor(params: {
    websites: CompatWebsite[];
    domains: CompatDomain[];
    videos: CompatVideo[];
    shareLinks: CompatShareLink[];
  }) {
    this.websites = params.websites;
    this.domains = params.domains;
    this.videos = params.videos;
    this.shareLinks = params.shareLinks;

    for (const video of this.videos) {
      if (video.binaryAsset !== null) {
        this.binaries.set(
          video.id,
          Buffer.from(
            "0123456789".slice(0, Number(video.binaryAsset.sizeBytes)),
          ),
        );
      }
    }
  }

  get shareLinkRecord(): CompatShareLink {
    const record = this.shareLinks[0];
    if (record === undefined) {
      throw new Error("compat fixture has no share link");
    }

    return record;
  }

  findShareLink(shareLinkId: string): CompatShareLink {
    const record = this.shareLinks.find((link) => link.id === shareLinkId);
    if (record === undefined) {
      throw new Error(`compat fixture has no share link ${shareLinkId}`);
    }

    return record;
  }

  findVideo(videoId: string): CompatVideo {
    const video = this.videos.find((entry) => entry.id === videoId);
    if (video === undefined) {
      throw new Error(`compat fixture has no video ${videoId}`);
    }

    return video;
  }

  findWebsite(websiteId: string): CompatWebsite {
    const website = this.websites.find((entry) => entry.id === websiteId);
    if (website === undefined) {
      throw new Error(`compat fixture has no website ${websiteId}`);
    }

    return website;
  }

  /** Test-only helper: flip an assignment without going through a service. */
  setAssignmentStatus(
    videoId: string,
    websiteId: string,
    status: AssignmentStatus,
  ): void {
    const assignment = this.findVideo(videoId).websiteVideos.find(
      (entry) => entry.websiteId === websiteId,
    );
    if (assignment === undefined) {
      throw new Error(`no assignment for ${videoId} on ${websiteId}`);
    }
    assignment.status = status;
  }

  private projectShareLinkVideos(
    record: CompatShareLink,
    query: ShareLinkVideosQuery | undefined,
  ): Array<{ id: string; sortOrder: number; videoId: string; video?: unknown }> {
    // Physical row order, exactly as the rows sit in the fixture.
    let rows = [...record.shareLinkVideos];
    const where = query?.where;

    if (where?.videoId !== undefined) {
      rows = rows.filter((row) => row.videoId === where.videoId);
    }

    const assignmentFilter = where?.video?.websiteVideos?.some;
    if (assignmentFilter !== undefined) {
      // Each predicate is applied only when the service asks for it, so
      // dropping `websiteId` or `status` from the query surfaces as "an
      // unassigned or DISABLED video became publicly playable" rather than as
      // a blanket "nothing resolves any more".
      rows = rows.filter((row) =>
        this.findVideo(row.videoId).websiteVideos.some(
          (assignment) =>
            (assignmentFilter.websiteId === undefined ||
              assignment.websiteId === assignmentFilter.websiteId) &&
            (assignmentFilter.status === undefined ||
              assignment.status === assignmentFilter.status),
        ),
      );
    }

    // Ordering is applied ONLY when the query asks for it. Removing `orderBy`
    // from production leaves the physical row order intact, which the
    // multi-video ordering test detects.
    if (query?.orderBy?.sortOrder === "asc") {
      rows = [...rows].sort((left, right) => left.sortOrder - right.sortOrder);
    } else if (query?.orderBy?.sortOrder === "desc") {
      rows = [...rows].sort((left, right) => right.sortOrder - left.sortOrder);
    }

    if (typeof query?.take === "number") {
      rows = rows.slice(0, query.take);
    }

    const videoSpec = query?.include?.video;
    if (videoSpec === undefined) {
      return rows.map((row) => ({ ...row }));
    }

    const videoInclude =
      typeof videoSpec === "object" ? videoSpec.include : undefined;

    return rows.map((row) => {
      const video = this.findVideo(row.videoId);

      return {
        ...row,
        video: {
          ...video,
          binaryAsset: applySelect(
            video.binaryAsset,
            videoInclude?.binaryAsset?.select,
          ),
          localFileAsset: applySelect(
            video.localFileAsset,
            videoInclude?.localFileAsset?.select,
          ),
          localThumbnailAsset: applySelect(
            video.localThumbnailAsset,
            videoInclude?.localThumbnailAsset?.select,
          ),
        },
      };
    });
  }

  websiteDomain = {
    findUnique: async (args: { where: { domain: string } }) => {
      this.counters.websiteDomainFindUnique += 1;
      const domain = this.domains.find(
        (entry) => entry.domain === args.where.domain,
      );
      if (domain === undefined) {
        return null;
      }

      return {
        id: domain.id,
        domain: domain.domain,
        status: domain.status,
        website: this.findWebsite(domain.websiteId),
      };
    },
  };

  website = {
    findUnique: async (args: { where: { id: string } }) => {
      const website = this.websites.find(
        (entry) => entry.id === args.where.id,
      );

      return website === undefined ? null : { ...website };
    },
  };

  videoAsset = {
    findUnique: async (args: { where: { id: string } }) => {
      const video = this.videos.find((entry) => entry.id === args.where.id);

      return video === undefined ? null : { ...video };
    },
    findMany: async (args: { where?: { id?: { in?: string[] } } }) => {
      const ids = args.where?.id?.in;

      return this.videos
        .filter((video) => ids === undefined || ids.includes(video.id))
        .map((video) => ({ ...video }));
    },
    update: async (args: {
      where: { id: string };
      data: { status?: VideoStatus };
    }) => {
      const video = this.findVideo(args.where.id);
      if (args.data.status !== undefined) {
        video.status = args.data.status;
      }

      return { ...video };
    },
  };

  websiteVideo = {
    findUnique: async (args: {
      where: { websiteId_videoId: { websiteId: string; videoId: string } };
    }) => {
      const { websiteId, videoId } = args.where.websiteId_videoId;
      const assignment = this.videos
        .find((entry) => entry.id === videoId)
        ?.websiteVideos.find((entry) => entry.websiteId === websiteId);

      return assignment === undefined ? null : { ...assignment };
    },
    findMany: async (args: {
      where?: { websiteId?: string; videoId?: { in?: string[] } };
    }) => {
      const websiteId = args.where?.websiteId;
      const ids = args.where?.videoId?.in;

      return this.videos
        .flatMap((video) => video.websiteVideos)
        .filter(
          (assignment) =>
            (websiteId === undefined || assignment.websiteId === websiteId) &&
            (ids === undefined || ids.includes(assignment.videoId)),
        )
        .map((assignment) => ({ ...assignment }));
    },
    update: async (args: {
      where: { id: string };
      data: { status?: AssignmentStatus };
    }) => {
      const assignment = this.videos
        .flatMap((video) => video.websiteVideos)
        .find((entry) => entry.id === args.where.id);
      if (assignment === undefined) {
        throw new Error(`no assignment ${args.where.id}`);
      }
      if (args.data.status !== undefined) {
        assignment.status = args.data.status;
      }

      return { ...assignment };
    },
    count: async (args: {
      where?: { websiteId?: string; status?: AssignmentStatus };
    }) =>
      this.videos
        .flatMap((video) => video.websiteVideos)
        .filter(
          (assignment) =>
            (args.where?.websiteId === undefined ||
              assignment.websiteId === args.where.websiteId) &&
            (args.where?.status === undefined ||
              assignment.status === args.where.status),
        ).length,
    aggregate: async () => ({ _max: { sortOrder: null } }),
    upsert: async (args: {
      where: { websiteId_videoId: { websiteId: string; videoId: string } };
      create: { status?: AssignmentStatus };
      update: { status?: AssignmentStatus };
    }) => {
      const { websiteId, videoId } = args.where.websiteId_videoId;
      const video = this.findVideo(videoId);
      const existing = video.websiteVideos.find(
        (entry) => entry.websiteId === websiteId,
      );

      if (existing === undefined) {
        const created = {
          id: `assignment-${videoId}-${websiteId}`,
          websiteId,
          videoId,
          status: args.create.status ?? AssignmentStatus.ACTIVE,
          sortOrder: 0,
        };
        video.websiteVideos.push(created);

        return { ...created, isFeatured: false, createdAt: FIXTURE_DATE, updatedAt: FIXTURE_DATE, video };
      }

      existing.status = args.update.status ?? AssignmentStatus.ACTIVE;

      return {
        ...existing,
        isFeatured: false,
        createdAt: FIXTURE_DATE,
        updatedAt: FIXTURE_DATE,
        video,
      };
    },
  };

  shareLink = {
    findFirst: async (args: {
      where: { alias?: string; tokenHash?: string; websiteId?: string };
      include?: { shareLinkVideos?: ShareLinkVideosQuery };
    }) => {
      this.counters.shareLinkFindFirst += 1;
      const record = this.shareLinks.find((link) => {
        // Only scope by website when the service asks for it, so that dropping
        // `websiteId` from the lookup surfaces as a real cross-tenant
        // authorization failure rather than as "nothing resolves".
        if (
          args.where.websiteId !== undefined &&
          link.websiteId !== args.where.websiteId
        ) {
          return false;
        }
        if (args.where.alias !== undefined) {
          return link.alias !== null && link.alias === args.where.alias;
        }
        if (args.where.tokenHash !== undefined) {
          return link.tokenHash === args.where.tokenHash;
        }

        return false;
      });

      if (record === undefined) {
        return null;
      }

      return {
        ...record,
        shareLinkVideos: this.projectShareLinkVideos(
          record,
          args.include?.shareLinkVideos,
        ),
      };
    },

    findUnique: async (args: { where: { id: string } }) => {
      this.counters.shareLinkFindUnique += 1;
      const record = this.shareLinks.find((link) => link.id === args.where.id);

      return record === undefined ? null : { ...record };
    },

    findUniqueOrThrow: async (args: {
      where: { id: string };
      include?: { shareLinkVideos?: ShareLinkVideosQuery };
    }) => {
      const record = this.shareLinks.find((link) => link.id === args.where.id);
      if (record === undefined) {
        throw new Error("share link not found");
      }

      return {
        ...record,
        shareLinkVideos: this.projectShareLinkVideos(
          record,
          args.include?.shareLinkVideos,
        ),
      };
    },

    update: async (args: {
      where: { id: string };
      data: { status?: ShareLinkStatus };
    }) => {
      const record = this.findShareLink(args.where.id);
      if (args.data.status !== undefined) {
        record.status = args.data.status;
      }
      record.updatedAt = new Date();

      return { ...record };
    },

    updateMany: async (args: {
      where: ShareLinkUpdateWhere;
      data: {
        currentViews?: { increment?: number };
        lastViewedAt?: Date;
        status?: ShareLinkStatus;
      };
    }): Promise<{ count: number }> => {
      this.counters.shareLinkUpdateMany += 1;

      // Form A - view consumption: exactly one link, targeted by id.
      if (args.where.id !== undefined) {
        const record = this.shareLinks.find(
          (link) => link.id === args.where.id,
        );

        if (record === undefined || !matchesUpdateWhere(record, args.where)) {
          return { count: 0 };
        }

        record.currentViews += args.data.currentViews?.increment ?? 0;
        if (args.data.lastViewedAt !== undefined) {
          record.lastViewedAt = args.data.lastViewedAt;
        }

        return { count: 1 };
      }

      // Form B - bulk status change, e.g. disabling every ACTIVE link that
      // contains a video being disabled.
      const memberVideoId = args.where.shareLinkVideos?.some?.videoId;
      let count = 0;
      for (const link of this.shareLinks) {
        if (args.where.status !== undefined && link.status !== args.where.status) {
          continue;
        }
        if (
          memberVideoId !== undefined &&
          !link.shareLinkVideos.some((row) => row.videoId === memberVideoId)
        ) {
          continue;
        }
        if (args.data.status !== undefined) {
          link.status = args.data.status;
          count += 1;
        }
      }

      return { count };
    },
  };

  accessLog = {
    create: async (args: {
      data: {
        status: AccessLogStatus;
        reasonCode: string;
        domain?: string;
        websiteId?: string;
        shareLinkId?: string;
      };
    }): Promise<void> => {
      this.accessLogs.push({ ...args.data });
    },
  };

  adminAuditLog = {
    create: async (args: {
      data: { action: string; entityId: string };
    }): Promise<{ id: string }> => {
      this.auditLogs.push({
        action: args.data.action,
        entityId: args.data.entityId,
      });

      return { id: `audit-${this.auditLogs.length}` };
    },
  };

  $transaction = async <T>(
    callback: (client: CompatPrismaService) => Promise<T>,
  ): Promise<T> => callback(this);

  /**
   * TEST-HARNESS INTERNAL - not a compatibility contract.
   *
   * Stands in for the bounded blob read in `readDatabaseVideoBinaryChunk()`.
   * The exact SQL text is deliberately NOT asserted anywhere: no public client
   * can observe it, so pinning it would be implementation coupling. The fake
   * needs only the *intent* - which video, which offset, how many bytes - and
   * reads that from the bound parameters without depending on their position:
   * the string parameter naming a known video identifies the row, and the two
   * numeric parameters are the one-based offset and the length, in the order
   * MySQL `SUBSTRING(str, pos, len)` takes them.
   *
   * Every release-gate assertion built on this is about returned bytes,
   * `Content-Range`, `Content-Length` and status - never about SQL.
   */
  $queryRaw = async (sql: {
    values: unknown[];
  }): Promise<Array<{ data: Buffer }>> => {
    this.counters.queryRaw += 1;
    const values = sql.values ?? [];
    const videoId = values.find(
      (value): value is string =>
        typeof value === "string" && this.binaries.has(value),
    );
    const [oneBasedStart, length] = values.filter(
      (value): value is number => typeof value === "number",
    );
    const buffer =
      videoId === undefined ? undefined : this.binaries.get(videoId);

    if (
      videoId === undefined ||
      buffer === undefined ||
      oneBasedStart === undefined ||
      length === undefined
    ) {
      return [];
    }

    const start = oneBasedStart - 1;
    this.lastBlobRead = { videoId, start, length };

    return [{ data: buffer.subarray(start, start + length) }];
  };

  /** TEST-HARNESS INTERNAL: what the last bounded blob read asked for. */
  lastBlobRead: { videoId: string; start: number; length: number } | null =
    null;
}

/* ------------------------------------------------------------------ *
 * Fake collaborators
 * ------------------------------------------------------------------ */

export class CompatConfigService {
  constructor(private readonly pepper: string = LEGACY_TOKEN_PEPPER) {}

  get<T = string>(key: string): T | undefined {
    const values: Record<string, string> = {
      SHARE_TOKEN_PEPPER: this.pepper,
      ACCESS_LOG_IP_PEPPER: "compat-suite-access-log-pepper",
      API_PREFIX: "api/v1",
      PUBLIC_MEDIA_GRANT_SECRET:
        "compat-suite-public-media-grant-secret-at-least-32-bytes",
      PUBLIC_MEDIA_GRANT_TTL_SECONDS: "21600",
    };

    return values[key] as T | undefined;
  }

  getOrThrow<T = string>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) {
      throw new Error(`${key} missing`);
    }

    return value;
  }
}

class CompatMemoryCacheConfigService {
  get<T = unknown>(key: string): T | undefined {
    return key === "api"
      ? ({ memoryCache: MEMORY_CACHE_CONFIG } as T)
      : undefined;
  }
}

export function createCompatMemoryCache(): MemoryCacheService {
  return new MemoryCacheService(new CompatMemoryCacheConfigService() as never);
}

/**
 * Streams deterministic bytes for suites that only care about authorization,
 * not about Range arithmetic. The media-delivery suite uses the real
 * `LocalVideoStorageService` against a temporary storage root instead.
 */
export class StubLocalVideoStorageService {
  readonly fullReadCalls: string[] = [];
  readonly rangeReadCalls: Array<{
    storageKey: string;
    rangeHeader?: string | undefined;
  }> = [];

  createFullReadStream(storageKey: string): {
    contentLength: number;
    stream: NodeJS.ReadableStream;
  } {
    this.fullReadCalls.push(storageKey);

    return {
      contentLength: 4,
      stream: Readable.from(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    };
  }

  createRangeReadStream(params: {
    storageKey: string;
    rangeHeader?: string | undefined;
  }): {
    statusCode: 200 | 206 | 416;
    contentLength: number;
    contentRange: string | null;
    stream: NodeJS.ReadableStream | null;
  } {
    this.rangeReadCalls.push(params);

    return {
      statusCode: 200,
      contentLength: 10,
      contentRange: null,
      stream: Readable.from(Buffer.from("0123456789")),
    };
  }
}

export class StubVideoViewGrowthService {
  readonly calls: Array<{ videoId: string; shareLinkId: string }> = [];

  async recordPublicVideoView(params: {
    videoId: string;
    shareLinkId: string;
  }): Promise<{
    videoId: string;
    viewCount: string;
    publishedAt: string | null;
  }> {
    this.calls.push({
      videoId: params.videoId,
      shareLinkId: params.shareLinkId,
    });

    return { videoId: params.videoId, viewCount: "1", publishedAt: null };
  }
}

/* ------------------------------------------------------------------ *
 * Scenario builder
 * ------------------------------------------------------------------ */

export type CompatShareLinkSpec = {
  id?: string;
  websiteId?: string;
  alias?: string | null;
  tokenHash?: string;
  status?: ShareLinkStatus;
  expiresAt?: Date | null;
  maxViews?: number | null;
  currentViews?: number;
  /** Membership rows in physical order; `sortOrder` defaults to the index. */
  videoIds?: string[];
  videoRows?: Array<{ videoId: string; sortOrder: number }>;
};

function buildShareLink(
  spec: CompatShareLinkSpec,
  fallbackId: string,
): CompatShareLink {
  const rows =
    spec.videoRows ??
    (spec.videoIds ?? []).map((videoId, index) => ({
      videoId,
      sortOrder: index,
    }));
  const id = spec.id ?? fallbackId;

  return {
    id,
    websiteId: spec.websiteId ?? WEBSITE_ID,
    tokenHash: spec.tokenHash ?? LEGACY_EXPECTED_TOKEN_HASH,
    alias: spec.alias === undefined ? LEGACY_ALIAS : spec.alias,
    label: null,
    status: spec.status ?? ShareLinkStatus.ACTIVE,
    expiresAt: spec.expiresAt ?? null,
    maxViews: spec.maxViews ?? null,
    currentViews: spec.currentViews ?? 0,
    lastViewedAt: null,
    createdAt: FIXTURE_DATE,
    updatedAt: FIXTURE_DATE,
    shareLinkVideos: rows.map((row, index) => ({
      id: `${id}-row-${index}`,
      sortOrder: row.sortOrder,
      videoId: row.videoId,
    })),
  };
}

export function defaultWebsites(): CompatWebsite[] {
  return [
    {
      id: WEBSITE_ID,
      name: "Customer Website",
      slug: "customer-website",
      status: WebsiteStatus.ACTIVE,
    },
    {
      id: FOREIGN_WEBSITE_ID,
      name: "Other Tenant",
      slug: "other-tenant",
      status: WebsiteStatus.ACTIVE,
    },
  ];
}

export function defaultDomains(): CompatDomain[] {
  return [
    {
      id: "domain-compat-1",
      domain: LEGACY_HOST,
      status: DomainStatus.ACTIVE,
      websiteId: WEBSITE_ID,
    },
    {
      id: "domain-compat-2",
      domain: SECOND_LEGACY_HOST,
      status: DomainStatus.ACTIVE,
      websiteId: WEBSITE_ID,
    },
    {
      id: "domain-compat-3",
      domain: FOREIGN_HOST,
      status: DomainStatus.ACTIVE,
      websiteId: FOREIGN_WEBSITE_ID,
    },
  ];
}

export type CompatHarness = {
  service: PublicService;
  prisma: CompatPrismaService;
  memoryCache: MemoryCacheService | undefined;
  localStorage: unknown;
  grants: PublicMediaGrantService;
  config: CompatConfigService;
  /** Real admin services, sharing this harness's Prisma fake and cache -
   *  exactly as the Nest container wires them in production. */
  adminWebsites: AdminWebsitesService;
  videos: VideosService;
};

export type CompatHarnessOptions = {
  /** Videos that are members of the primary share link, in physical order. */
  videos: CompatVideo[];
  /** Explicit rows when `sortOrder` must differ from the physical order. */
  shareLinkVideoRows?: Array<{ videoId: string; sortOrder: number }>;
  /** Videos that exist globally but belong to no share link. */
  standaloneVideos?: CompatVideo[];
  /** Overrides for the primary share link. */
  shareLink?: Partial<
    Pick<
      CompatShareLink,
      "status" | "expiresAt" | "maxViews" | "currentViews" | "alias"
    >
  >;
  /** Additional share links, e.g. a second credential on the same website. */
  extraShareLinks?: CompatShareLinkSpec[];
  websites?: CompatWebsite[];
  domains?: CompatDomain[];
  memoryCache?: boolean;
  pepper?: string;
  localVideoStorage?: unknown;
};

export function createCompatHarness(
  options: CompatHarnessOptions,
): CompatHarness {
  const allVideos = [...options.videos, ...(options.standaloneVideos ?? [])];
  const primary = buildShareLink(
    {
      ...(options.shareLink ?? {}),
      ...(options.shareLinkVideoRows === undefined
        ? { videoIds: options.videos.map((video) => video.id) }
        : { videoRows: options.shareLinkVideoRows }),
    },
    SHARE_LINK_ID,
  );
  const extras = (options.extraShareLinks ?? []).map((spec, index) =>
    buildShareLink(spec, `share-link-compat-extra-${index}`),
  );

  const prisma = new CompatPrismaService({
    websites: options.websites ?? defaultWebsites(),
    domains: options.domains ?? defaultDomains(),
    videos: allVideos,
    shareLinks: [primary, ...extras],
  });
  const config = new CompatConfigService(options.pepper ?? LEGACY_TOKEN_PEPPER);
  const memoryCache =
    options.memoryCache === true ? createCompatMemoryCache() : undefined;
  const localStorage =
    options.localVideoStorage ?? new StubLocalVideoStorageService();
  const grants = new PublicMediaGrantService(config as never);
  const service = new PublicService(
    prisma as never,
    config as never,
    localStorage as never,
    new StubVideoViewGrowthService() as never,
    grants,
    memoryCache,
  );
  const adminWebsites = new AdminWebsitesService(
    prisma as never,
    config as never,
    { clearDomainOriginCache: () => undefined } as never,
    memoryCache,
  );
  const videos = new VideosService(
    prisma as never,
    {} as never, // CloudinaryService - unused by the mutation paths under test
    config as never,
    {} as never, // VideoMetadataService - unused by the mutation paths
    localStorage as never,
    memoryCache,
  );

  return {
    service,
    prisma,
    memoryCache,
    localStorage,
    grants,
    config,
    adminWebsites,
    videos,
  };
}

/* ------------------------------------------------------------------ *
 * Assertion helpers
 *
 * These favour parsed, order-insensitive comparisons over exact string or key
 * ordering, so that a cosmetic change cannot fail a compatibility gate.
 * ------------------------------------------------------------------ */

export function readQueryParam(
  url: string | null | undefined,
  name: string,
): string | null {
  if (!url) {
    return null;
  }

  return new URL(url, "https://api.example.com").searchParams.get(name);
}

/** Reads the `grant` query parameter out of a backend-served media URL. */
export function readGrant(url: string | null | undefined): string | null {
  return readQueryParam(url, "grant");
}

/** Splits a media URL into its pathname and its query parameters as a map. */
export function parseMediaUrl(url: string | null | undefined): {
  pathname: string;
  params: Record<string, string>;
} {
  if (!url) {
    throw new Error("expected a media URL");
  }

  const parsed = new URL(url, "https://api.example.com");

  return {
    pathname: decodeURIComponent(parsed.pathname),
    params: Object.fromEntries(parsed.searchParams.entries()),
  };
}

export async function readStream(
  stream: NodeJS.ReadableStream | null,
): Promise<Buffer> {
  if (stream === null) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

/** Order-insensitive property-set comparison. */
export function propertyNames(value: object): string[] {
  return Object.keys(value).sort();
}
