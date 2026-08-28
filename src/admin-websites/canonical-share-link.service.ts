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
  CANONICAL_AUTO_ADOPT_SELECTION_POLICY,
  selectCanonicalHistoricalWinner,
  type CanonicalAdoptionCandidate,
  type CanonicalPinBlocker,
} from "./utils/canonical-adoption-policy.util";
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
  /**
   * The pair's newest historical link cannot be pinned as a permanent identity.
   *
   * Three structural faults, each with NOTHING written — no mapping, no
   * replacement link, and no fallback to an older candidate. Falling back or
   * minting would silently hand out a working credential for a pair whose
   * newest credential an owner had deliberately restricted.
   */
  historicalAliasMissing: "CANONICAL_HISTORICAL_ALIAS_MISSING",
  historicalOptionsPresent: "CANONICAL_HISTORICAL_OPTIONS_PRESENT",
  historicalIntegrityConflict: "CANONICAL_HISTORICAL_INTEGRITY_CONFLICT",
  /**
   * An ALREADY-EXISTING mapping whose anchored ShareLink violates the canonical
   * contract. A SEPARATE FAMILY from the `historical*` codes above, deliberately.
   *
   * Those three describe a SELECTION that was refused: nothing was pinned, and
   * their messages tell the operator about "the newest existing share link" the
   * resolver was about to adopt. Reusing one here would be a lie — this pair was
   * pinned long ago, no selection is happening, and no alternative link is in
   * play. An operator told "the newest link cannot be adopted" would go looking
   * for a selection to influence, and there is none.
   *
   * Nor does any other existing code fit: `CANONICAL_DOMAIN_UNAVAILABLE` is
   * about the anchored domain, `CANONICAL_EVIDENCE_*` about the video's
   * identity, `CANONICAL_LINK_REVOKED` / `_INACTIVE` about status, and
   * `CANONICAL_LINK_OPTIONS_NOT_ALLOWED` about options on an INBOUND REQUEST,
   * not on a stored row. So these are new, and minimal: one per remediation.
   *
   * The split matches `classifyExistingCanonical()` in the read-only audit
   * (`scripts/audit/canonical-share-link-audit-core.ts`), and so does the ORDER
   * they are checked in — an audit that names a different fault than the runtime
   * refuses with is the same defect as an audit that predicts a different
   * winner. `fault` on the response body carries the audit's own
   * `ExistingCanonicalFinding` value.
   *
   * IN EVERY CASE THE MAPPING IS LEFT EXACTLY AS IT IS. These refusals never
   * repoint it, never delete it, and never mint a replacement: an existing
   * `CanonicalVideoShareLink` is authoritative forever, and "unusable" is not
   * "wrong". The only thing withheld is the URL.
   */
  linkAliasMissing: "CANONICAL_LINK_ALIAS_MISSING",
  linkOptionsPresent: "CANONICAL_LINK_OPTIONS_PRESENT",
  linkIntegrityConflict: "CANONICAL_LINK_INTEGRITY_CONFLICT",
  /**
   * @deprecated NO LONGER EMITTED by any code path.
   *
   * Ordinary pre-canonical duplication is now resolved automatically by
   * `selectCanonicalHistoricalWinner()`: the NEWEST exact single-video link is
   * the identity, whatever its status. There is exactly one newest link, so no
   * irreducible ambiguity is left for this code to describe.
   *
   * The constant is retained because `bom-media-admin`
   * (`canonicalShareLinkPolicy.ts`) still carries a message keyed by it and a
   * client that receives an unknown code falls back to a generic string. It
   * costs nothing to keep and removing it would be a cross-repo change.
   */
  ambiguousHistory: "CANONICAL_LINK_AMBIGUOUS",
} as const;

/**
 * Audit actions written by the canonical subsystem. Automatic adoption of a
 * pre-existing historical link, a brand-new mint, and a deliberate
 * operator-driven adoption are three different facts and must never be
 * conflated: only one of the three brought a credential into being, and only
 * one of the three was a human decision.
 */
export const CANONICAL_AUDIT_ACTIONS = {
  create: "CANONICAL_SHARE_LINK_CREATE",
  autoAdopt: "CANONICAL_SHARE_LINK_AUTO_ADOPT",
  operatorAdopt: "CANONICAL_SHARE_LINK_ADOPT",
} as const;

/**
 * The Prisma surface `buildEvidenceSnapshot()` needs. Narrow on purpose, so
 * both the service client and an open transaction client satisfy it and the
 * CREATE path can snapshot inside its own transaction.
 */
type CanonicalEvidenceClient = Pick<Prisma.TransactionClient, "videoAsset">;

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

  /**
   * Resolve the pair's ONE canonical link: reuse an existing mapping, adopt the
   * newest historical link, or mint a fresh one — in that order.
   *
   * ORDER 1 — AN EXISTING MAPPING IS ALWAYS AUTHORITATIVE.
   * Once `CanonicalVideoShareLink(websiteId, videoId)` exists it is the answer,
   * permanently. History is not re-scanned and a newer duplicate appearing
   * later never repoints it: canonical identity is what DMCA submissions and
   * reviewer bookmarks were built on, so it must not move because a second link
   * happened to be created afterwards. Changing it is an explicit,
   * OWNER-driven operation (`adoptExistingShareLink()`), never a side effect of
   * someone pressing "Get link".
   *
   * ORDER 2 — ONLY WHEN NO MAPPING EXISTS may history decide, and the answer is
   * the NEWEST exact single-video link (`createdAt DESC`, `id DESC`). Its
   * status is NOT an input. A REVOKED or DISABLED winner is still the pair's
   * correct identity; it is pinned and the request then fails closed with that
   * link's own code. Promoting an older ACTIVE link, or minting a replacement,
   * would silently return access an owner deliberately removed.
   *
   * ORDER 3 — ONLY a pair with NO history at all mints a fresh canonical link.
   * A pair that has history resolves to one of its links or to an explicit
   * refusal. Legacy rows are never deleted, revoked or rewritten either way.
   *
   * EVERY PRECONDITION IS READ INSIDE THE SERIALIZABLE TRANSACTION.
   * Website status, video eligibility, the active domain and the evidence
   * snapshot were previously loaded before the transaction opened, which left a
   * window in which a concurrent disable / unassign / domain change committed
   * between the read and the canonical write. The mapping is permanent and its
   * relations are `onDelete: Restrict`, so a record committed against stale
   * preconditions is not a transient error — it is a row an operator then has
   * to unpick by hand. They are now read with `tx`.
   */
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

    const tokenPepper = this.configService
      .get<string>("SHARE_TOKEN_PEPPER")
      ?.trim();
    if (!tokenPepper) {
      throw new BadRequestException("SHARE_TOKEN_PEPPER is required.");
    }

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
            // (1) WEBSITE STATUS, read inside the transaction. A website
            // disabled a moment ago must not acquire a new permanent canonical
            // mapping.
            const website = await tx.website.findFirst({
              where: { id: websiteId, status: WebsiteStatus.ACTIVE },
              select: { id: true },
            });
            if (website === null) {
              throw new NotFoundException("Active website not found.");
            }

            // (2) VIDEO ELIGIBILITY, read inside the transaction: READY,
            // publicly playable, and ACTIVE-assigned to THIS website. The same
            // predicate the ordinary bundle path enforces through
            // `ensureShareLinkCreationScope()`; the canonical path used to
            // check it against `this.prisma` before the transaction opened.
            await this.adminWebsitesService.validateShareLinkVideoEligibility(
              tx,
              websiteId,
              [videoId],
            );

            // (3) CANONICAL DOMAIN, read inside the transaction. This value is
            // frozen into `canonicalDomainId` + `canonicalHostSnapshot` and the
            // relation is `onDelete: Restrict`, so anchoring a domain that was
            // disabled between the read and the write produces a mapping that
            // fails `assertReusable()` from then on.
            const domain = await tx.websiteDomain.findFirst({
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

            // (4) EVIDENCE SNAPSHOT, read inside the transaction, so the
            // fingerprint committed alongside the mapping describes the video
            // row as it exists at commit time. Snapshotting first and
            // committing later can store a fingerprint that no longer matches,
            // which surfaces as an immediate CANONICAL_EVIDENCE_DRIFT on the
            // very next read of a mapping that was only just created.
            const snapshot = await this.buildEvidenceSnapshot(videoId, tx);
            const fingerprint = this.computeFingerprint(snapshot);
            const protocol =
              this.adminWebsitesService.getConfiguredPublicSiteProtocol(
                domain.domain,
              );

            // (5) THE CANDIDATE SCAN LIVES INSIDE THE TRANSACTION, DELIBERATELY.
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

            // (6) THE WINNER IS THE NEWEST LINK. STATUS IS NOT AN INPUT.
            //
            // IDENTITY IS NOT USABILITY. A REVOKED or DISABLED link is still
            // this pair's correct permanent identity; the request then fails
            // closed below with that link's own code. Filtering to "usable"
            // candidates first would silently promote an older ACTIVE link, or
            // mint a fresh one, and either outcome hands back access an owner
            // deliberately removed. See the header of
            // `canonical-adoption-policy.util.ts` for the two concrete bypasses.
            const selection = selectCanonicalHistoricalWinner(candidates, {
              websiteId,
              videoId,
            });
            const adopted = selection.winner;

            // (7) STRUCTURAL PINNABILITY, CHECKED BEFORE ANY WRITE.
            //
            // A narrow set of faults make the winner impossible to pin at all —
            // as opposed to merely unusable. Each is an explicit refusal with
            // NOTHING written: this throw rolls the transaction back, so no
            // mapping, no replacement link, and no older candidate promoted.
            //
            // This is the one part of the ordering that genuinely had to move.
            // An alias-less winner used to be committed and only then rejected,
            // by an exception thrown while BUILDING THE RESPONSE — leaving a
            // mapping that could never resolve and that no HTTP path can undo.
            if (adopted !== null && selection.pinBlocker !== null) {
              this.throwHistoricalPinBlocked(
                selection.pinBlocker,
                selection.historicalCandidateCount,
              );
            }

            const shareLinkId =
              adopted?.id ??
              (
                await (async () => {
                  // THE ONLY MINTING PATH: a pair with NO history at all. A
                  // pair that has history always resolves to one of its links
                  // or to a refusal, because minting for a revoked, expiring or
                  // budgeted history would manufacture the very credential the
                  // owner's restriction was meant to withhold.
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
                // Automatic adoption of a pre-existing link is a different fact
                // from minting a new one, and the audit trail must not conflate
                // them: only one of the two brought a credential into being.
                action: adopted
                  ? CANONICAL_AUDIT_ACTIONS.autoAdopt
                  : CANONICAL_AUDIT_ACTIONS.create,
                module: "admin-websites",
                entityType: "CanonicalVideoShareLink",
                entityId: canonical.id,
                status: AuditStatus.SUCCESS,
                // SAFE METADATA ONLY. Ids here are internal cuids, not bearer
                // credentials. The ALIAS is deliberately absent: on the bound
                // host it authorizes a public watch all by itself
                // (`share-url.util.ts`), so it is a bearer secret and must
                // never reach an audit row. Neither may the raw token, its
                // peppered hash, or SHARE_TOKEN_PEPPER.
                metadataJson: {
                  websiteId,
                  videoId,
                  shareLinkId,
                  historicalCandidateCount: selection.historicalCandidateCount,
                  ...(adopted
                    ? {
                        adoptedHistoricalLink: true,
                        selectionPolicy: CANONICAL_AUTO_ADOPT_SELECTION_POLICY,
                        // The status the identity was pinned AT. A REVOKED
                        // value here is not an error: it records that the pair
                        // was pinned to a link an owner had already taken away,
                        // which is exactly what stops a later request from
                        // quietly minting a working replacement.
                        adoptedStatus: adopted.status,
                      }
                    : {}),
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
          // whatever state the adopted link is in. Usability is a SEPARATE
          // question, and a revoked or expired link must answer it truthfully
          // rather than be replaced.
          //
          // This is not a validate-after-commit defect. The checks that had to
          // precede the write — the ones whose failure would leave an
          // unremediable mapping — are the structural ones in step (7). What
          // runs here is the ordinary usability verdict, and its refusal is the
          // product behaviour: a pair whose link was revoked stays revoked, and
          // no replacement credential is ever minted for it.
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
            // The DELIBERATE, operator-chosen adoption. Distinct from
            // CANONICAL_SHARE_LINK_AUTO_ADOPT, which the create path writes
            // when the resolver picked a historical link by policy: one is a
            // human decision about which already-circulated URL is official,
            // the other is a deterministic rule. Conflating them would make the
            // provenance trail unable to answer "who chose this?".
            action: CANONICAL_AUDIT_ACTIONS.operatorAdopt,
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
   * Every EXACT single-video share link for this pair, NEWEST FIRST.
   *
   * "Exact" is the load-bearing word. A bundle `[A, B]` contains A, so any
   * `some: { videoId }` condition would match it — and adopting a bundle as
   * the canonical link for A would publish B to everyone who follows A's
   * canonical URL. The cardinality is therefore PROVEN, not assumed: the rows
   * are fetched and filtered on `length === 1 && [0].videoId === videoId`,
   * which no `where` clause can express directly.
   *
   * NO STATUS FILTER, AND NO `canonicalVideoShareLink: null` FILTER.
   *
   * Both were here and both were wrong, for the same reason: a `where` clause
   * that removes a row makes it invisible, and an invisible newest link means
   * an OLDER link silently becomes the winner.
   *
   * - Filtering by status would let a revoke be routed around.
   * - Filtering out an already-anchored link would hide a data-integrity fault
   *   — `shareLinkId` is unique, so one link anchoring two pairs cannot happen
   *   by design — and quietly bless an older candidate in its place. The
   *   relation is SELECTED instead, so the caller can refuse explicitly.
   *
   * ORDERING IS PART OF THE CONTRACT, and it is done by the DATABASE first.
   * `createdAt DESC` because the newest link is the pair's identity; `id DESC`
   * purely as a deterministic tie-break when two rows share a `createdAt`,
   * which MySQL `DATETIME(3)` makes entirely possible for links minted in the
   * same millisecond. The shared policy re-sorts with the same comparator, so
   * the winner is also independent of the column's collation.
   */
  private async findExactSingleVideoCandidates(
    tx: Pick<PrismaService, "shareLink">,
    websiteId: string,
    videoId: string,
  ): Promise<CanonicalAdoptionCandidate[]> {
    const rows = await tx.shareLink.findMany({
      where: {
        websiteId,
        shareLinkVideos: { some: { videoId } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        alias: true,
        status: true,
        expiresAt: true,
        maxViews: true,
        createdAt: true,
        shareLinkVideos: { select: { videoId: true } },
        canonicalVideoShareLink: {
          select: { websiteId: true, videoId: true },
        },
      },
    });

    return rows
      .filter(
        (row) =>
          row.shareLinkVideos.length === 1 &&
          row.shareLinkVideos[0]?.videoId === videoId,
      )
      .map((row) => ({
        id: row.id,
        alias: row.alias,
        status: row.status,
        expiresAt: row.expiresAt,
        maxViews: row.maxViews,
        createdAt: row.createdAt,
        anchoredPair: row.canonicalVideoShareLink,
      }));
  }

  /**
   * Refuses a pair whose newest historical link cannot be pinned.
   *
   * Stable, distinct codes so an operator (and the Admin console) can tell the
   * three faults apart — they need different remediation. Nothing has been
   * written when this throws: the transaction rolls back, so there is no
   * mapping, no replacement link, and no older candidate promoted.
   *
   * `historicalCandidateCount` is safe to return: it is a count, not a
   * credential. No alias, token, hash or link id crosses this boundary.
   */
  private throwHistoricalPinBlocked(
    blocker: CanonicalPinBlocker,
    historicalCandidateCount: number,
  ): never {
    const detail: Record<
      CanonicalPinBlocker,
      { code: string; message: string }
    > = {
      ALIAS_MISSING: {
        code: CANONICAL_ERROR_CODES.historicalAliasMissing,
        message:
          "The newest existing share link for this website and video has no usable alias, so it cannot become the canonical URL. A replacement is deliberately not created, because that would hand out access this pair's existing link may no longer grant. Restore the alias on that link, then retry.",
      },
      HAS_EXPIRY: {
        code: CANONICAL_ERROR_CODES.historicalOptionsPresent,
        message:
          "The newest existing share link for this website and video carries an expiry, which a canonical link cannot honour. Neither adopting nor replacing it is safe: one would ignore the expiry, the other would bypass it. Clear the expiry on that link, or resolve the pair deliberately.",
      },
      HAS_MAX_VIEWS: {
        code: CANONICAL_ERROR_CODES.historicalOptionsPresent,
        message:
          "The newest existing share link for this website and video carries a view limit, which a canonical link cannot honour. Neither adopting nor replacing it is safe: one would ignore the limit, the other would bypass it. Clear the limit on that link, or resolve the pair deliberately.",
      },
      ANCHORED_TO_OTHER_PAIR: {
        code: CANONICAL_ERROR_CODES.historicalIntegrityConflict,
        message:
          "The newest existing share link for this website and video is already the canonical link of a different website+video pair. That is a data-integrity fault, not a state this request may work around, so nothing was written and no other link was selected in its place. Owner review is required.",
      },
    };

    const { code, message } = detail[blocker];

    throw new ConflictException({
      message,
      code,
      blocker,
      historicalCandidateCount,
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

  /**
   * Every reason an EXISTING mapping may not be handed back as a URL.
   *
   * THE MAPPING IS NEVER TOUCHED HERE. Not repointed, not deleted, not repaired,
   * and no replacement minted — `createOrGetCanonical()` returned from the
   * existing-mapping branch before any history was even scanned, and every path
   * below only throws. An existing `CanonicalVideoShareLink` is authoritative
   * forever; a refusal withholds the URL, it does not revise the identity.
   *
   * STATUS IS ANSWERED FIRST, and that is a deliberate contract, not an
   * accident of where the code sits.
   *
   * A REVOKED or DISABLED pair is unavailable BY AN OWNER'S DECISION, and that
   * is the fact the operator has to hear first: it is the only one whose remedy
   * is a decision rather than a repair. Telling them "restore the alias" or
   * "clear the expiry" about a link the owner deliberately took away would send
   * them to fix the wrong thing, and could end with them restoring access that
   * was removed on purpose. `CANON-13`/`CANON-14` in
   * `test/canonical-single-video-create.test.ts` pin exactly this for a link
   * that carries BOTH a terminal status and a legacy budget: the answer is
   * `CANONICAL_LINK_INACTIVE`.
   *
   * Nothing is handed out under either order — every branch below refuses — so
   * this ordering costs no safety. It only decides which remediation the
   * operator is pointed at.
   *
   * Among ACTIVE links the order then follows `classifyExistingCanonical()`
   * exactly (alias → website → membership → expiry → view limit), so the
   * read-only audit and the runtime name the SAME fault wherever the audit's
   * own answer is not `STATUS_NOT_ACTIVE`.
   */
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

    this.assertAnchoredLinkHonoursContract(canonical);

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

  /**
   * Refuses BEFORE URL CONSTRUCTION when the anchored ShareLink cannot honour
   * the canonical contract.
   *
   * WHY THIS RUNS AT ALL, GIVEN THE CREATE PATH ALREADY REFUSES THESE.
   * `assessHistoricalWinnerPinnability()` stops the same five faults from being
   * pinned, but only for mappings written by the CURRENT code. Mappings written
   * before that check existed are still in the database — KI-022 residue — and
   * so are rows produced by a restore or a direct SQL edit. Those are exactly
   * the rows this method exists for. It is therefore not a duplicate of the
   * pin check: one guards what may be WRITTEN, this guards what may be READ BACK
   * AS A URL, and the second has to hold for rows the first never saw.
   *
   * WHY BEFORE `toResponse()` RATHER THAN LETTING THE BUILDER THROW.
   * `buildCanonicalReviewUrl()` does refuse an empty alias, so an alias-less
   * mapping already failed closed — but as a bare `400 "Canonical share alias is
   * required."` raised while SERIALIZING A RESPONSE, with no stable code for the
   * Admin console to key a message off and no indication that the pair needs
   * owner remediation rather than a retry. The other four never reached the
   * builder at all: an expiring, view-limited, foreign-website or wrong-membership
   * link has a perfectly valid alias, so a canonical URL was returned and the
   * Admin was told the pair had a permanent link it does not have.
   *
   * NOTHING IS WRITTEN, ON ANY BRANCH. No repoint, no delete, no replacement
   * mint, and no fallback to a historical link — the caller has already returned
   * from the existing-mapping branch, so history is never even scanned. The
   * mapping stays byte-for-byte as it was and waits for an owner.
   *
   * REACHED ONLY FOR AN `ACTIVE` LINK. `assertReusable()` answers a REVOKED or
   * DISABLED pair before calling this, because an owner's deliberate removal is
   * the fact to report first — see the ordering note there. The faults below are
   * therefore exactly the ones that would OTHERWISE HAVE PRODUCED A URL.
   *
   * PUBLIC RESOLUTION IS UNAFFECTED AND UNCHANGED. `src/public/public.service.ts`
   * never reads `CanonicalVideoShareLink`, and enforces status, `expiresAt` and
   * `maxViews` from the link's own row in `getDeniedReason()`, in the atomic
   * `incrementShareLinkView()` guard, and in `getDeniedReasonForMediaPlayback()`.
   * A mapping pinned to a limited link therefore could not serve a reviewer past
   * its limit even before this method existed; what was wrong was the ADMIN side
   * calling such a URL permanent.
   */
  private assertAnchoredLinkHonoursContract(
    canonical: CanonicalWithRelations,
  ): void {
    const link = canonical.shareLink;

    // (1) ALIAS — the canonical URL's entire credential. Checked first because
    // it is the one fault with a cheap, non-destructive remediation (restore the
    // alias on the anchored link) that leaves provenance untouched.
    if (link.alias === null || link.alias.trim() === "") {
      throw this.canonicalContractConflict(
        CANONICAL_ERROR_CODES.linkAliasMissing,
        "ALIAS_MISSING",
        "The share link this website and video is permanently pinned to has no usable alias, so no canonical URL can be built from it. The mapping is deliberately left exactly as it is — repointing it would rewrite provenance, and minting a replacement would hand out a credential this pair never had. Restore the alias on that link, then retry.",
      );
    }

    // (2) WEBSITE BINDING. The mapping says this pair; the link says another
    // website. One of the two is wrong and this code cannot know which, so it
    // refuses instead of guessing — and emphatically does not repoint.
    if (link.websiteId !== canonical.websiteId) {
      throw this.canonicalContractConflict(
        CANONICAL_ERROR_CODES.linkIntegrityConflict,
        "WEBSITE_MISMATCH",
        "The share link this pair is pinned to belongs to a different website, so it cannot represent this website's canonical URL. That is a data-integrity fault, not a state this request may work around: nothing was written, the mapping is unchanged, and no other link was selected in its place. Owner review is required.",
      );
    }

    // (3) EXACT MEMBERSHIP. A `[A, B]` membership anchored for A would publish
    // B to every reviewer who follows A's canonical URL, so cardinality is
    // PROVEN here exactly as `findExactSingleVideoCandidates()` proves it for a
    // selection candidate.
    const memberVideoIds = link.shareLinkVideos.map((row) => row.videoId);
    if (
      memberVideoIds.length !== 1 ||
      memberVideoIds[0] !== canonical.videoId
    ) {
      throw this.canonicalContractConflict(
        CANONICAL_ERROR_CODES.linkIntegrityConflict,
        "MEMBERSHIP_MISMATCH",
        "The share link this pair is pinned to does not contain exactly this one video, so its URL would not show what the canonical record claims — and a link carrying additional videos would publish them to every reviewer who follows it. Nothing was written and the mapping is unchanged. Owner review is required.",
      );
    }

    // (4) and (5) LEGACY ACCESS CONTROLS the canonical contract cannot
    // represent. Reported after the structural faults and before status,
    // mirroring `classifyExistingCanonical()`. Public resolution still enforces
    // both, so nothing here is a bypass; what is refused is the claim that a
    // link which will lapse is a PERMANENT identity.
    if (link.expiresAt !== null) {
      throw this.canonicalContractConflict(
        CANONICAL_ERROR_CODES.linkOptionsPresent,
        "HAS_EXPIRY",
        "The share link this pair is pinned to carries an expiry, which a canonical link cannot honour: the URL would be reported as permanent and then stop working, with no replacement possible. The mapping is unchanged and nothing was minted. Clear the expiry on that link, or resolve the pair deliberately.",
      );
    }
    if (link.maxViews !== null) {
      throw this.canonicalContractConflict(
        CANONICAL_ERROR_CODES.linkOptionsPresent,
        "HAS_MAX_VIEWS",
        "The share link this pair is pinned to carries a view limit, which a canonical link cannot honour: the URL would be reported as permanent and then stop working, with no replacement possible. The mapping is unchanged and nothing was minted. Clear the limit on that link, or resolve the pair deliberately.",
      );
    }
  }

  /**
   * SAFE BODY ONLY. `fault` is the audit's own `ExistingCanonicalFinding` value
   * — an enum label, not data — and the message names no identifier. The alias
   * is a bearer credential on the bound host (`share-url.util.ts`) and the raw
   * token and its peppered hash are secrets, so none of the three may appear in
   * an error an operator can screenshot or a client can log.
   */
  private canonicalContractConflict(
    code: string,
    fault: string,
    message: string,
  ): ConflictException {
    return new ConflictException({ message, code, fault });
  }

  /**
   * The evidence-critical identity of a video, as of one point in time.
   *
   * `client` defaults to the service-level Prisma instance for the read-only
   * callers (`getCanonical()`, drift recomputation). The CREATE path passes the
   * open transaction instead, so the snapshot committed next to the mapping
   * describes the row as it exists AT COMMIT, not as it looked before the
   * transaction opened.
   */
  private async buildEvidenceSnapshot(
    videoId: string,
    client: CanonicalEvidenceClient = this.prisma,
  ): Promise<CanonicalEvidenceSnapshot> {
    const video = (await client.videoAsset.findUnique({
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
