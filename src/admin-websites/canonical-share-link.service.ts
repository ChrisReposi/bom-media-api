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
  VideoSourceType,
  WebsiteStatus,
  type CanonicalVideoShareLink,
  type VideoAsset,
  type VideoBinaryAsset,
  type VideoLocalFileAsset,
} from "../generated/prisma/client";
import { hashShareToken } from "../public/utils/share-token.util";
import { AdminWebsitesService } from "./admin-websites.service";
import type { CreateShareLinkDto } from "./dto/create-share-link.dto";
import type { CreateShareLinkResponse } from "./types/admin-share-link-response.type";
import type { CanonicalShareLinkResponse } from "./types/canonical-share-link-response.type";
import {
  isShareLinkTokenOrAliasCollision,
  isUniqueViolationOn,
} from "./utils/share-link-errors.util";
import {
  buildCanonicalPublicShareUrl,
  buildCanonicalReviewUrl,
  generateShareAlias,
  generateShareToken,
} from "./utils/share-url.util";

const CANONICAL_CREATE_MAX_ATTEMPTS = 5;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const CANONICAL_ERROR_CODES = {
  inactive: "CANONICAL_LINK_INACTIVE",
  revoked: "CANONICAL_LINK_REVOKED",
  domainUnavailable: "CANONICAL_DOMAIN_UNAVAILABLE",
  evidenceDrift: "CANONICAL_EVIDENCE_DRIFT",
  evidenceIncomplete: "CANONICAL_EVIDENCE_INCOMPLETE",
  videoNotShareable: "CANONICAL_VIDEO_NOT_SHAREABLE",
  notFound: "CANONICAL_LINK_NOT_FOUND",
  optionsNotAllowed: "CANONICAL_LINK_OPTIONS_NOT_ALLOWED",
  ambiguousHistory: "CANONICAL_LINK_AMBIGUOUS",
} as const;

type VideoWithEvidenceAssets = VideoAsset & {
  localFileAsset: Pick<
    VideoLocalFileAsset,
    "checksumSha256" | "sizeBytes" | "mimeType"
  > | null;
  binaryAsset: Pick<
    VideoBinaryAsset,
    "checksumSha256" | "sizeBytes" | "mimeType"
  > | null;
};

type SourceIntegrityEvidence = Pick<
  CanonicalEvidenceSnapshot,
  "checksumSha256" | "sizeBytes" | "mimeType"
>;

/**
 * Evidence-critical identity, covering every source type: LOCAL_FILE and
 * DB_BLOB carry source-specific checksum/size/mime; DIRECT_URL/provider upload
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

    const currentFingerprint = await this.computeCurrentFingerprint(
      canonical,
      videoId,
    );
    return this.toResponse(canonical, {
      outcome: "REUSED",
      evidenceDrift:
        canonical.evidenceFingerprint !== null &&
        currentFingerprint !== canonical.evidenceFingerprint,
    });
  }

  /**
   * The single entry point behind `POST /admin/websites/:id/share-links`.
   *
   * A request for EXACTLY ONE video is a request for that website+video pair's
   * canonical link, whoever makes it — the Admin console, a retry after a
   * network timeout, a second operator clicking Create at the same moment, or a
   * direct API call. Routing lives HERE, on the server, for that reason: an
   * Admin-side "look for an existing link first" cannot be correct, because two
   * clients can both look, both miss, and both create.
   *
   * Multi-video requests are untouched and keep minting a fresh bundle link.
   * The two are different products and may coexist for the same video: a
   * canonical `[A]` and a bundle `[A, B]` collide nowhere, because canonical
   * identity is carried by the dedicated `CanonicalVideoShareLink` mapping and
   * never by `ShareLinkVideo` membership.
   */
  async createShareLinkForRequest(
    websiteId: string,
    dto: CreateShareLinkDto,
    adminId: string,
  ): Promise<CreateShareLinkResponse> {
    const resolvedVideoIds =
      await this.adminWebsitesService.resolveShareLinkVideoIds(websiteId, dto);

    if (resolvedVideoIds.length !== 1) {
      return this.adminWebsitesService.createShareLink(
        websiteId,
        dto,
        adminId,
        resolvedVideoIds,
      );
    }

    this.assertCanonicalOptionsAbsent(dto);

    const canonical = await this.createOrGetCanonical(
      websiteId,
      resolvedVideoIds[0],
      adminId,
    );

    // Deliberately no `rawToken`. On REUSED none was minted, and on CREATED the
    // canonical contract does not expose one (see the create transaction: the
    // token is hashed and the plaintext is dropped inside this service). The
    // alias carried in `publicUrl` is the credential a reviewer uses.
    return {
      message:
        canonical.outcome === "CREATED"
          ? "Canonical share link created."
          : "Existing canonical share link reused.",
      shareLink: canonical.shareLink,
      publicUrl: canonical.reviewUrl,
      outcome: canonical.outcome,
      isCanonical: true,
    };
  }

  /**
   * A canonical link is permanent and unlimited by construction: it is the one
   * stable identity for the pair, and `createOrGetCanonical()` writes
   * `label: null, expiresAt: null, maxViews: null`.
   *
   * Accepting these options and silently dropping them would be worse than
   * refusing — `maxViews` is an access control, and an operator told "link
   * created" would believe a budget applied that does not exist. Accepting them
   * and honouring them on first creation is worse still: the pair's one identity
   * would then be able to expire, with no way to mint a replacement.
   *
   * So the request is refused, and the operator chooses deliberately: clear the
   * options for the canonical link, or build a multi-video bundle where limits
   * do apply.
   */
  private assertCanonicalOptionsAbsent(dto: CreateShareLinkDto): void {
    const rejected: string[] = [];
    if (dto.expiresAt !== undefined && dto.expiresAt !== null) {
      rejected.push("expiresAt");
    }
    if (dto.maxViews !== undefined && dto.maxViews !== null) {
      rejected.push("maxViews");
    }
    if (typeof dto.label === "string" && dto.label.trim() !== "") {
      rejected.push("label");
    }

    if (rejected.length > 0) {
      throw new BadRequestException({
        message: `A single-video share link is the canonical link for this website and video, and cannot carry ${rejected.join(", ")}. Clear ${rejected.length === 1 ? "it" : "them"}, or select more than one video.`,
        code: CANONICAL_ERROR_CODES.optionsNotAllowed,
      });
    }
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
        const settled = await this.prisma.$transaction(
          async (tx) => {
            // THE CANDIDATE SCAN LIVES INSIDE THE TRANSACTION, DELIBERATELY.
            //
            // A pair that already has an exact single-video link must adopt it
            // rather than mint a second one — that is the whole product rule.
            // Scanning outside the transaction would leave a window in which
            // this request sees no candidate, another request commits one, and
            // this one still mints the duplicate the rule exists to prevent.
            // Serializable + the scan in the same transaction closes it.
            const candidates = await this.findExactSingleVideoCandidates(
              tx,
              websiteId,
              videoId,
            );

            if (candidates.length > 1) {
              // No provenance says WHICH already-circulated URL is the official
              // one, and guessing would silently bless one reviewer's link over
              // another's. Refuse and let an owner adopt deliberately. Nothing
              // is written: this throw rolls the transaction back.
              this.throwAmbiguousHistory(candidates.length);
            }

            const adopted = candidates[0] ?? null;
            const shareLinkId =
              adopted?.id ??
              (
                await (async () => {
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
                  return shareLink;
                })()
              ).id;

            const canonical = await tx.canonicalVideoShareLink.create({
              data: {
                websiteId,
                videoId,
                shareLinkId,
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
                // Adoption of a pre-existing link is a different fact from
                // minting a new one, and the audit trail must not conflate
                // them: only one of the two brought a credential into being.
                action: adopted
                  ? "CANONICAL_SHARE_LINK_ADOPT"
                  : "CANONICAL_SHARE_LINK_CREATE",
                module: "admin-websites",
                entityType: "CanonicalVideoShareLink",
                entityId: canonical.id,
                status: AuditStatus.SUCCESS,
                metadataJson: {
                  websiteId,
                  videoId,
                  shareLinkId,
                  ...(adopted ? { adoptedHistoricalLink: true } : {}),
                } as Prisma.InputJsonValue,
              },
            });

            const row = await tx.canonicalVideoShareLink.findUniqueOrThrow({
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

            return { row, adopted: adopted !== null };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        const canonical = settled.row as CanonicalWithRelations;

        if (settled.adopted) {
          // The mapping is committed: the pair now has one permanent identity,
          // whatever state the adopted link is in. Usability is a separate
          // question, and a revoked or expired link must answer it truthfully
          // rather than be replaced.
          await this.assertReusable(canonical, websiteId, videoId);
          return this.toResponse(canonical, {
            outcome: "REUSED",
            evidenceDrift: false,
          });
        }

        return this.toResponse(canonical, {
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

  /**
   * Every EXACT single-video share link for this pair that is not already
   * anchoring some other canonical mapping.
   *
   * "Exact" is the load-bearing word. A bundle `[A, B]` contains A, so any
   * `some: { videoId }` condition would match it — and adopting a bundle as
   * the canonical link for A would publish B to everyone who follows A's
   * canonical URL. The cardinality is therefore PROVEN, not assumed: the rows
   * are fetched and filtered on `length === 1 && [0].videoId === videoId`,
   * which no `where` clause can express directly.
   *
   * `canonicalVideoShareLink: null` excludes a link already anchoring another
   * pair's mapping, because `shareLinkId` is unique on that table and reusing
   * one would fail the constraint anyway.
   *
   * Ordering is by `createdAt` purely for determinism in the >1 case, where the
   * result is a refusal. It is NEVER used to pick a winner — see
   * `throwAmbiguousHistory()`.
   */
  private async findExactSingleVideoCandidates(
    tx: Pick<PrismaService, "shareLink">,
    websiteId: string,
    videoId: string,
  ): Promise<{ id: string; alias: string | null }[]> {
    const rows = await tx.shareLink.findMany({
      where: {
        websiteId,
        canonicalVideoShareLink: { is: null },
        shareLinkVideos: { some: { videoId } },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        alias: true,
        shareLinkVideos: { select: { videoId: true } },
      },
    });

    return rows
      .filter(
        (row) =>
          row.shareLinkVideos.length === 1 &&
          row.shareLinkVideos[0]?.videoId === videoId,
      )
      .map((row) => ({ id: row.id, alias: row.alias }));
  }

  private throwAmbiguousHistory(candidateCount: number): never {
    throw new ConflictException({
      message: `${candidateCount} existing share links already contain exactly this video on this website. Which one is the official URL cannot be inferred, and creating another is not an option — adopt one of them as the canonical link first.`,
      code: CANONICAL_ERROR_CODES.ambiguousHistory,
      candidateCount,
    });
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

    const currentFingerprint = await this.computeCurrentFingerprint(
      canonical,
      videoId,
    );
    if (
      canonical.evidenceFingerprint !== null &&
      currentFingerprint !== canonical.evidenceFingerprint
    ) {
      throw new ConflictException({
        message:
          "The video's evidence-critical identity changed since the canonical snapshot. Owner review is required before reusing this canonical URL.",
        code: CANONICAL_ERROR_CODES.evidenceDrift,
      });
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
        binaryAsset: {
          select: {
            checksumSha256: true,
            sizeBytes: true,
            mimeType: true,
          },
        },
      },
    })) as VideoWithEvidenceAssets | null;
    if (video === null) {
      throw new NotFoundException("Video not found.");
    }

    const integrity = this.resolveSourceIntegrityEvidence(video);

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
      ...integrity,
      snapshotAt: new Date().toISOString(),
    };
  }

  private resolveSourceIntegrityEvidence(
    video: VideoWithEvidenceAssets,
  ): SourceIntegrityEvidence {
    if (video.sourceType === VideoSourceType.LOCAL_FILE) {
      return {
        checksumSha256: video.localFileAsset?.checksumSha256 ?? null,
        sizeBytes: video.localFileAsset?.sizeBytes.toString() ?? null,
        mimeType: video.localFileAsset?.mimeType ?? null,
      };
    }

    if (video.sourceType === VideoSourceType.DB_BLOB) {
      const binary = video.binaryAsset;
      if (
        binary === null ||
        binary.checksumSha256 === null ||
        !SHA256_HEX_PATTERN.test(binary.checksumSha256)
      ) {
        this.throwEvidenceIncomplete();
      }
      return {
        checksumSha256: binary.checksumSha256,
        sizeBytes: binary.sizeBytes.toString(),
        mimeType: binary.mimeType,
      };
    }

    // Remote/provider identifiers remain useful deterministic evidence, but
    // they do not prove that bytes served behind the identifier are immutable.
    return { checksumSha256: null, sizeBytes: null, mimeType: null };
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
    canonical: CanonicalWithRelations,
    videoId: string,
  ): Promise<string> {
    const currentSnapshot = await this.buildEvidenceSnapshot(videoId);
    this.assertStoredEvidenceComplete(
      canonical.evidenceSnapshotJson,
      currentSnapshot.sourceType,
    );
    return this.computeFingerprint(currentSnapshot);
  }

  private assertStoredEvidenceComplete(
    snapshotValue: Prisma.JsonValue | null,
    currentSourceType: string,
  ): void {
    const snapshot =
      typeof snapshotValue === "object" &&
      snapshotValue !== null &&
      !Array.isArray(snapshotValue)
        ? snapshotValue
        : null;
    const storedSourceType = snapshot?.sourceType;
    const storedChecksum = snapshot?.checksumSha256;
    const storedDbChecksumComplete =
      storedSourceType === VideoSourceType.DB_BLOB &&
      typeof storedChecksum === "string" &&
      SHA256_HEX_PATTERN.test(storedChecksum);

    if (
      (storedSourceType === VideoSourceType.DB_BLOB &&
        !storedDbChecksumComplete) ||
      (currentSourceType === VideoSourceType.DB_BLOB &&
        !storedDbChecksumComplete)
    ) {
      this.throwEvidenceIncomplete();
    }
  }

  private throwEvidenceIncomplete(): never {
    throw new ConflictException({
      message:
        "Canonical evidence is incomplete because this database video has no valid persisted SHA-256 checksum. Operator remediation is required.",
      code: CANONICAL_ERROR_CODES.evidenceIncomplete,
    });
  }

  private isSerializationConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034"
    );
  }

  /**
   * A lost race for this pair's mapping. Both unique constraints on
   * `CanonicalVideoShareLink` can report it, and which one fires depends on the
   * index the engine checks first: `(websiteId, videoId)` when two requests
   * raced the same pair, or `shareLinkId` when two requests raced to adopt the
   * SAME historical link. Matching only the first would leave the adoption race
   * unrecovered, so both are treated as "someone else won; reload theirs".
   */
  private isCanonicalPairConflict(error: unknown): boolean {
    return (
      isUniqueViolationOn(error, "websiteId_videoId") ||
      isUniqueViolationOn(error, "shareLinkId")
    );
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
    const reviewUrl = buildCanonicalReviewUrl({
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
      // The nested `shareLink.publicUrl` is the REVIEWER url, matching what
      // every other share-link response carries. The pinned provenance shape
      // stays on the top-level `publicUrl` alone.
      shareLink: this.adminWebsitesService.toShareLinkResponse(
        canonical.shareLink,
        reviewUrl,
      ),
      publicUrl,
      reviewUrl,
      alias: canonical.shareLink.alias ?? "",
      evidenceSnapshot:
        (canonical.evidenceSnapshotJson as CanonicalEvidenceSnapshot | null) ??
        null,
      canonicalCreatedAt: canonical.createdAt,
    };
  }
}
