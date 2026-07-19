import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../database/prisma.service";
import {
  AuditStatus,
  DomainStatus,
  Prisma,
  ShareLinkStatus,
  WebsiteStatus,
  type CanonicalVideoShareLink,
  type VideoAsset,
  type VideoLocalFileAsset,
} from "../generated/prisma/client";
import { hashShareToken } from "../public/utils/share-token.util";
import { AdminWebsitesService } from "./admin-websites.service";
import type { CanonicalShareLinkResponse } from "./types/canonical-share-link-response.type";
import {
  isShareLinkTokenOrAliasCollision,
  isUniqueViolationOn,
} from "./utils/share-link-errors.util";
import {
  buildCanonicalPublicShareUrl,
  generateShareAlias,
  generateShareToken,
} from "./utils/share-url.util";

const CANONICAL_CREATE_MAX_ATTEMPTS = 5;

export const CANONICAL_ERROR_CODES = {
  inactive: "CANONICAL_LINK_INACTIVE",
  revoked: "CANONICAL_LINK_REVOKED",
  domainUnavailable: "CANONICAL_DOMAIN_UNAVAILABLE",
  evidenceDrift: "CANONICAL_EVIDENCE_DRIFT",
  videoNotShareable: "CANONICAL_VIDEO_NOT_SHAREABLE",
  notFound: "CANONICAL_LINK_NOT_FOUND",
} as const;

type VideoWithLocalFile = VideoAsset & {
  localFileAsset: Pick<
    VideoLocalFileAsset,
    "checksumSha256" | "sizeBytes" | "mimeType"
  > | null;
  binaryAsset: { sizeBytes: bigint; mimeType: string } | null;
};

/**
 * Evidence-critical identity, covering every source type: LOCAL_FILE carries
 * checksum/size/mime; DB_BLOB carries binary size/mime; DIRECT_URL/CLOUDINARY
 * carry playbackUrl/providerAssetId; EMBED carries provider/url/publicId.
 * Fields prove content *integrity*, never copyright ownership. `snapshotAt`
 * is informational only and excluded from the deterministic fingerprint.
 */
export type CanonicalEvidenceSnapshot = {
  videoId: string;
  sourceType: string;
  title: string;
  durationSeconds: number | null;
  publishedAt: string | null;
  playbackUrl: string | null;
  providerAssetId: string | null;
  embedProvider: string | null;
  embedUrl: string | null;
  embedPublicId: string | null;
  checksumSha256: string | null;
  sizeBytes: string | null;
  mimeType: string | null;
  snapshotAt: string;
};

type CanonicalWithRelations = CanonicalVideoShareLink & {
  shareLink: Parameters<AdminWebsitesService["toShareLinkResponse"]>[0];
};

/**
 * One canonical public URL per website+video pair, for DMCA/provenance
 * records. Create-or-get is idempotent and race-safe: the database unique
 * constraint on (websiteId, videoId) is the arbiter, and losers of a race
 * return the winner's link with outcome REUSED. The host/protocol are
 * snapshotted at creation so the URL never follows later domain changes, and
 * an evidence fingerprint detects drift of the underlying video identity.
 */
@Injectable()
export class CanonicalShareLinkService {
  private readonly logger = new Logger(CanonicalShareLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly adminWebsitesService: AdminWebsitesService,
  ) {}

  async getCanonical(
    websiteId: string,
    videoId: string,
  ): Promise<CanonicalShareLinkResponse> {
    const canonical = await this.loadCanonical(websiteId, videoId);
    if (canonical === null) {
      throw new NotFoundException({
        message: "No canonical share link exists for this website and video.",
        code: CANONICAL_ERROR_CODES.notFound,
      });
    }

    const currentFingerprint = await this.computeCurrentFingerprint(videoId);
    return this.toResponse(canonical, {
      outcome: "REUSED",
      evidenceDrift:
        canonical.evidenceFingerprint !== null &&
        currentFingerprint !== canonical.evidenceFingerprint,
    });
  }

  async createOrGetCanonical(
    websiteId: string,
    videoId: string,
    adminId: string,
  ): Promise<CanonicalShareLinkResponse> {
    await this.ensureActiveWebsite(websiteId);

    const existing = await this.loadCanonical(websiteId, videoId);
    if (existing !== null) {
      await this.assertReusable(existing, websiteId, videoId);
      return this.toResponse(existing, {
        outcome: "REUSED",
        evidenceDrift: false,
      });
    }

    await this.adminWebsitesService.validateShareLinkVideoEligibility(
      this.prisma,
      websiteId,
      [videoId],
    );

    const domain = await this.prisma.websiteDomain.findFirst({
      where: {
        websiteId,
        status: DomainStatus.ACTIVE,
        website: { is: { status: WebsiteStatus.ACTIVE } },
      },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { id: true, domain: true },
    });
    if (domain === null) {
      throw new BadRequestException(
        "Website must have one ACTIVE assigned domain before creating a canonical link.",
      );
    }

    const tokenPepper = this.configService
      .get<string>("SHARE_TOKEN_PEPPER")
      ?.trim();
    if (!tokenPepper) {
      throw new BadRequestException("SHARE_TOKEN_PEPPER is required.");
    }

    const protocol = this.adminWebsitesService.getConfiguredPublicSiteProtocol(
      domain.domain,
    );
    const snapshot = await this.buildEvidenceSnapshot(videoId);
    const fingerprint = this.computeFingerprint(snapshot);

    for (
      let attempt = 1;
      attempt <= CANONICAL_CREATE_MAX_ATTEMPTS;
      attempt += 1
    ) {
      if (attempt > 1) {
        // A retried loser usually lost the pair race: reuse the winner
        // instead of burning another Serializable transaction.
        const raced = await this.loadCanonical(websiteId, videoId);
        if (raced !== null) {
          await this.assertReusable(raced, websiteId, videoId);
          return this.toResponse(raced, {
            outcome: "REUSED",
            evidenceDrift: false,
          });
        }
      }

      const transientToken = generateShareToken();
      const alias = generateShareAlias();
      const tokenHash = hashShareToken({
        token: transientToken,
        pepper: tokenPepper,
      });

      try {
        const created = await this.prisma.$transaction(
          async (tx) => {
            const shareLink = await tx.shareLink.create({
              data: {
                websiteId,
                tokenHash,
                alias,
                label: null,
                expiresAt: null,
                maxViews: null,
                currentViews: 0,
                status: ShareLinkStatus.ACTIVE,
              },
            });
            await tx.shareLinkVideo.create({
              data: { shareLinkId: shareLink.id, videoId, sortOrder: 0 },
            });
            const canonical = await tx.canonicalVideoShareLink.create({
              data: {
                websiteId,
                videoId,
                shareLinkId: shareLink.id,
                canonicalDomainId: domain.id,
                canonicalHostSnapshot: domain.domain,
                canonicalProtocol: protocol ?? "https",
                evidenceFingerprint: fingerprint,
                evidenceSnapshotJson:
                  snapshot as unknown as Prisma.InputJsonValue,
              },
            });
            await tx.adminAuditLog.create({
              data: {
                adminId,
                action: "CANONICAL_SHARE_LINK_CREATE",
                module: "admin-websites",
                entityType: "CanonicalVideoShareLink",
                entityId: canonical.id,
                status: AuditStatus.SUCCESS,
                metadataJson: {
                  websiteId,
                  videoId,
                  shareLinkId: shareLink.id,
                } as Prisma.InputJsonValue,
              },
            });

            return tx.canonicalVideoShareLink.findUniqueOrThrow({
              where: { id: canonical.id },
              include: {
                shareLink: {
                  include: {
                    shareLinkVideos: {
                      include: { video: true },
                      orderBy: { sortOrder: "asc" },
                    },
                  },
                },
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        return this.toResponse(created as CanonicalWithRelations, {
          outcome: "CREATED",
          evidenceDrift: false,
        });
      } catch (error) {
        if (this.isCanonicalPairConflict(error)) {
          const winner = await this.loadCanonical(websiteId, videoId);
          if (winner !== null) {
            await this.assertReusable(winner, websiteId, videoId);
            return this.toResponse(winner, {
              outcome: "REUSED",
              evidenceDrift: false,
            });
          }
          continue;
        }
        if (
          attempt < CANONICAL_CREATE_MAX_ATTEMPTS &&
          (isShareLinkTokenOrAliasCollision(error) ||
            this.isSerializationConflict(error))
        ) {
          // Serializable transactions racing on the same pair surface P2034
          // write conflicts; a bounded retry lets the loser hit the P2002
          // winner-reload path (or win a later attempt) instead of failing.
          continue;
        }
        throw error;
      }
    }

    throw new ConflictException(
      "Could not create a unique canonical share link. Please try again.",
    );
  }

  /**
   * Adopt an existing (legacy) ShareLink as the canonical mapping for its
   * website+video pair. Local/operator tooling only — never exposed as an
   * HTTP endpoint. The owner chooses which legacy link is canonical (e.g. the
   * one already cited in DMCA records); nothing is auto-selected.
   */
  async adoptExistingShareLink(params: {
    websiteId: string;
    videoId: string;
    shareLinkId: string;
    adminId: string;
  }): Promise<CanonicalShareLinkResponse> {
    const { websiteId, videoId, shareLinkId, adminId } = params;
    await this.ensureActiveWebsite(websiteId);

    const shareLink = await this.prisma.shareLink.findUnique({
      where: { id: shareLinkId },
      include: {
        shareLinkVideos: {
          include: { video: true },
          orderBy: { sortOrder: "asc" },
        },
      },
    });
    if (shareLink === null || shareLink.websiteId !== websiteId) {
      throw new BadRequestException(
        "Share link does not belong to this website.",
      );
    }
    if (shareLink.status !== ShareLinkStatus.ACTIVE) {
      throw new ConflictException({
        message: "Only an ACTIVE share link can be adopted as canonical.",
        code: CANONICAL_ERROR_CODES.inactive,
      });
    }
    if (
      shareLink.shareLinkVideos.length !== 1 ||
      shareLink.shareLinkVideos[0].videoId !== videoId
    ) {
      throw new BadRequestException(
        "Canonical adoption requires a link containing exactly the target video.",
      );
    }
    if (!shareLink.alias) {
      throw new BadRequestException(
        "Canonical adoption requires a link with an alias.",
      );
    }
    if (shareLink.expiresAt !== null || shareLink.maxViews !== null) {
      throw new BadRequestException(
        "Canonical links cannot carry expiresAt or maxViews. Clear them first or choose another link.",
      );
    }

    await this.adminWebsitesService.validateShareLinkVideoEligibility(
      this.prisma,
      websiteId,
      [videoId],
    );

    const domain = await this.prisma.websiteDomain.findFirst({
      where: {
        websiteId,
        status: DomainStatus.ACTIVE,
        website: { is: { status: WebsiteStatus.ACTIVE } },
      },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { id: true, domain: true },
    });
    if (domain === null) {
      throw new BadRequestException(
        "Website must have one ACTIVE assigned domain before adopting a canonical link.",
      );
    }

    const snapshot = await this.buildEvidenceSnapshot(videoId);
    const fingerprint = this.computeFingerprint(snapshot);
    const protocol = this.adminWebsitesService.getConfiguredPublicSiteProtocol(
      domain.domain,
    );

    const adopted = await this.prisma.$transaction(
      async (tx) => {
        const canonical = await tx.canonicalVideoShareLink.create({
          data: {
            websiteId,
            videoId,
            shareLinkId,
            canonicalDomainId: domain.id,
            canonicalHostSnapshot: domain.domain,
            canonicalProtocol: protocol ?? "https",
            evidenceFingerprint: fingerprint,
            evidenceSnapshotJson: snapshot as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminId,
            action: "CANONICAL_SHARE_LINK_ADOPT",
            module: "admin-websites",
            entityType: "CanonicalVideoShareLink",
            entityId: canonical.id,
            status: AuditStatus.SUCCESS,
            metadataJson: {
              websiteId,
              videoId,
              shareLinkId,
            } as Prisma.InputJsonValue,
          },
        });
        return tx.canonicalVideoShareLink.findUniqueOrThrow({
          where: { id: canonical.id },
          include: {
            shareLink: {
              include: {
                shareLinkVideos: {
                  include: { video: true },
                  orderBy: { sortOrder: "asc" },
                },
              },
            },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return this.toResponse(adopted as CanonicalWithRelations, {
      outcome: "CREATED",
      evidenceDrift: false,
    });
  }

  /** Guard used by domain mutations that would change canonical resolution. */
  async ensureDomainHasNoCanonicalLinks(domainId: string): Promise<void> {
    const count = await this.prisma.canonicalVideoShareLink.count({
      where: { canonicalDomainId: domainId },
    });
    if (count > 0) {
      throw new ConflictException({
        message:
          "This domain anchors canonical share links used for provenance records. Resolve those canonical links before changing the domain.",
        code: "DOMAIN_HAS_ACTIVE_CANONICAL_LINKS",
      });
    }
  }

  private async ensureActiveWebsite(websiteId: string): Promise<void> {
    const website = await this.prisma.website.findFirst({
      where: { id: websiteId, status: WebsiteStatus.ACTIVE },
      select: { id: true },
    });
    if (website === null) {
      throw new NotFoundException("Active website not found.");
    }
  }

  private async loadCanonical(
    websiteId: string,
    videoId: string,
  ): Promise<CanonicalWithRelations | null> {
    return (await this.prisma.canonicalVideoShareLink.findUnique({
      where: { websiteId_videoId: { websiteId, videoId } },
      include: {
        shareLink: {
          include: {
            shareLinkVideos: {
              include: { video: true },
              orderBy: { sortOrder: "asc" },
            },
          },
        },
      },
    })) as CanonicalWithRelations | null;
  }

  private async assertReusable(
    canonical: CanonicalWithRelations,
    websiteId: string,
    videoId: string,
  ): Promise<void> {
    if (canonical.shareLink.status === ShareLinkStatus.REVOKED) {
      throw new ConflictException({
        message:
          "The canonical share link was revoked. Owner review is required; a replacement is never created silently.",
        code: CANONICAL_ERROR_CODES.revoked,
      });
    }
    if (canonical.shareLink.status !== ShareLinkStatus.ACTIVE) {
      throw new ConflictException({
        message:
          "The canonical share link is inactive. Owner review is required.",
        code: CANONICAL_ERROR_CODES.inactive,
      });
    }

    const domain = await this.prisma.websiteDomain.findUnique({
      where: { id: canonical.canonicalDomainId },
      select: { domain: true, status: true, websiteId: true },
    });
    if (
      domain === null ||
      domain.status !== DomainStatus.ACTIVE ||
      domain.websiteId !== websiteId ||
      domain.domain !== canonical.canonicalHostSnapshot
    ) {
      throw new ConflictException({
        message:
          "The canonical domain is no longer available in its recorded state. Owner review is required.",
        code: CANONICAL_ERROR_CODES.domainUnavailable,
      });
    }

    try {
      await this.adminWebsitesService.validateShareLinkVideoEligibility(
        this.prisma,
        websiteId,
        [videoId],
      );
    } catch {
      throw new ConflictException({
        message:
          "The canonical video is no longer shareable on this website. The existing canonical URL is preserved; no replacement is created.",
        code: CANONICAL_ERROR_CODES.videoNotShareable,
      });
    }

    if (canonical.evidenceFingerprint !== null) {
      const currentFingerprint = await this.computeCurrentFingerprint(videoId);
      if (
        currentFingerprint !== null &&
        currentFingerprint !== canonical.evidenceFingerprint
      ) {
        throw new ConflictException({
          message:
            "The video's evidence-critical identity changed since the canonical snapshot. Owner review is required before reusing this canonical URL.",
          code: CANONICAL_ERROR_CODES.evidenceDrift,
        });
      }
    }
  }

  private async buildEvidenceSnapshot(
    videoId: string,
  ): Promise<CanonicalEvidenceSnapshot> {
    const video = (await this.prisma.videoAsset.findUnique({
      where: { id: videoId },
      include: {
        localFileAsset: {
          select: { checksumSha256: true, sizeBytes: true, mimeType: true },
        },
        binaryAsset: { select: { sizeBytes: true, mimeType: true } },
      },
    })) as VideoWithLocalFile | null;
    if (video === null) {
      throw new NotFoundException("Video not found.");
    }

    const sizeBytes =
      video.localFileAsset?.sizeBytes ?? video.binaryAsset?.sizeBytes ?? null;

    return {
      videoId: video.id,
      sourceType: video.sourceType,
      title: video.title,
      durationSeconds: video.durationSeconds,
      publishedAt: video.publishedAt?.toISOString() ?? null,
      playbackUrl: video.playbackUrl,
      providerAssetId: video.providerAssetId,
      embedProvider: video.embedProvider,
      embedUrl: video.embedUrl,
      embedPublicId: video.embedPublicId,
      checksumSha256: video.localFileAsset?.checksumSha256 ?? null,
      sizeBytes: sizeBytes?.toString() ?? null,
      mimeType:
        video.localFileAsset?.mimeType ?? video.binaryAsset?.mimeType ?? null,
      snapshotAt: new Date().toISOString(),
    };
  }

  /**
   * Deterministic fingerprint over evidence-critical identity only.
   * `snapshotAt` is excluded so a recomputation over unchanged source data
   * always reproduces the stored fingerprint.
   */
  computeFingerprint(snapshot: CanonicalEvidenceSnapshot): string {
    const { snapshotAt: _snapshotAt, ...identity } = snapshot;
    const canonicalJson = JSON.stringify(
      Object.fromEntries(
        Object.entries(identity).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
    return createHash("sha256").update(canonicalJson).digest("hex");
  }

  private async computeCurrentFingerprint(
    videoId: string,
  ): Promise<string | null> {
    try {
      return this.computeFingerprint(await this.buildEvidenceSnapshot(videoId));
    } catch {
      return null;
    }
  }

  private isSerializationConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034"
    );
  }

  private isCanonicalPairConflict(error: unknown): boolean {
    return isUniqueViolationOn(error, "websiteId_videoId");
  }

  private toResponse(
    canonical: CanonicalWithRelations,
    options: {
      outcome: "CREATED" | "REUSED";
      evidenceDrift: boolean;
    },
  ): CanonicalShareLinkResponse {
    const publicUrl = buildCanonicalPublicShareUrl({
      host: canonical.canonicalHostSnapshot,
      alias: canonical.shareLink.alias ?? "",
      protocol: canonical.canonicalProtocol,
    });

    return {
      message:
        options.outcome === "CREATED"
          ? "Canonical share link created."
          : "Existing canonical share link reused.",
      outcome: options.outcome,
      isCanonical: true,
      evidenceDrift: options.evidenceDrift,
      shareLink: this.adminWebsitesService.toShareLinkResponse(
        canonical.shareLink,
        publicUrl,
      ),
      publicUrl,
      alias: canonical.shareLink.alias ?? "",
      evidenceSnapshot:
        (canonical.evidenceSnapshotJson as CanonicalEvidenceSnapshot | null) ??
        null,
      canonicalCreatedAt: canonical.createdAt,
    };
  }
}
