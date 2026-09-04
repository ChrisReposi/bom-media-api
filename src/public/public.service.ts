import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  isBunnyPullZoneUrl,
  resolveBunnyThumbnailUpstreamUrl,
} from "../bunny/bunny-cdn-thumbnail.util";
import { BunnyStreamService } from "../bunny/bunny-stream.service";
import { BunnyThumbnailProxyService } from "../bunny/bunny-thumbnail-proxy.service";
import {
  classifyBunnyVideoAsset,
  isBunnyRemoteMissing,
} from "../bunny/bunny-video-asset.util";
import {
  buildCacheKey,
  hashCacheKeyPart,
} from "../cache/memory-cache-key.util";
import { MemoryCacheService } from "../cache/memory-cache.service";
import {
  isCompatibilityCapableHost,
  isWellFormedTransportAlias,
} from "../admin-websites/utils/share-url.util";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import {
  AccessLogStatus,
  AssignmentStatus,
  DomainStatus,
  ShareLinkStatus,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
  type ShareLink,
  type VideoAsset,
  type Website,
} from "../generated/prisma/client";
import {
  LocalVideoStorageService,
  type LocalStorageRangeResult,
} from "../videos/storage/local-video-storage.service";
import { VideoViewGrowthService } from "../videos/video-view-growth.service";
import { PublicMediaGrantService } from "./public-media-grant.service";
import { PublicReviewResumeService } from "./public-review-resume.service";
import {
  hashIpAddress,
  sanitizeAccessLogReferer,
  truncateAccessLogValue,
  truncateDomain,
  truncateReasonCode,
} from "./utils/access-log.util";
import { RESUME_MEDIA_TOKEN_PREFIX } from "./utils/grant-signature.util";
import { normalizePublicHost } from "./utils/normalize-host.util";
import { hashShareToken } from "./utils/share-token.util";
import type {
  PublicVideoViewResponse,
  PublicWatchResponse,
} from "./types/public-watch-response.type";
import {
  type PublicWatchReasonCode,
  type PublicWatchVideoResponse,
  type PublicWatchWebsiteResponse,
} from "./types/public-watch-response.type";

/**
 * Bunny player overrides for the PUBLIC reviewer embed.
 *
 * `autoplay=false` so the reviewer sees the poster frame before playback
 * instead of the video starting on its own. Bunny's embed page renders
 * `<video ... autoplay ...>` by default (the library's Player setting) and
 * already carries the correct `data-poster`, so suppressing autoplay is what
 * makes that poster visible — a share link that opens on a still frame the
 * reviewer clicks once to play.
 *
 * These parameters are appended after the credential pair and are NOT part of
 * the embed token, which hashes `videoId + expires` only. Authorization,
 * signing order and the atomic view consumption are completely unaffected.
 */
const PUBLIC_BUNNY_PLAYER_PARAMS = { autoplay: "false" } as const;

type PublicWatchRequestMeta = {
  ip?: string | undefined;
  userAgent?: string | undefined;
  referer?: string | undefined;
};

type ResolvePublicWatchParams = {
  host: string;
  token?: string;
  requestMeta?: PublicWatchRequestMeta | undefined;
  /**
   * How this request arrived, which decides two things and nothing else:
   * whether a view is consumed, and whether a resume grant is minted.
   *
   *   "watch"   the `#k` exchange and the legacy GET. Consumes a view.
   *             Mints NO grant: the fragment is still in the reviewer's URL
   *             and survives a refresh on its own, so there is nothing to
   *             resume and no reason to put a credential in storage.
   *   "compat"  the email-safe `?r=` exchange. Consumes a view, and mints a
   *             grant — this is the ONLY flow that scrubs its carrier, so it
   *             is the only one whose session a refresh would otherwise lose.
   *   "resume"  redeeming a grant. Consumes NOTHING, and mints no new grant:
   *             the reviewer already holds one, and re-minting on every
   *             refresh would silently extend the TTL forever.
   */
  origin?: "watch" | "compat" | "resume";
  /**
   * The verified expiry of the resume grant that produced this request, so
   * the media tokens minted below can be clamped to it. Absent on every other
   * origin. NOT an authorization fact — nothing concludes "still valid" from
   * it; it is a ceiling.
   */
  resumeNotAfter?: number | undefined;
};

type ResolvePublicWatchCompatibleParams = {
  host: string;
  alias: string;
  requestMeta?: PublicWatchRequestMeta | undefined;
};

type ResolvePublicWatchResumeParams = {
  host: string;
  grant: string;
  requestMeta?: PublicWatchRequestMeta | undefined;
};

/**
 * How a response's backend media URLs name the ShareLink.
 *
 *   "credential"  the presented alias or raw token, echoed into the path for
 *                 the historical `#k` contract only
 *   "aliasFree"   a per-video, host-bound, short-lived rmv1 token used by
 *                 BOTH compatibility and resume
 *
 * THIS IS THE FIX FOR A REAL ESCALATION. Because a resume re-enters the
 * resolver using the row's own alias, every media URL used to echo that alias
 * back — so one redemption of a stolen resume grant yielded `ShareLink.alias`,
 * and `/watch#k=<alias>` then worked after the grant expired, after
 * `sessionStorage` was cleared, and after the host was removed from
 * `PUBLIC_COMPATIBILITY_URL_HOSTS`. The TTL bounded nothing.
 */
type MediaTokenMode =
  | { kind: "credential" }
  | { kind: "aliasFree"; shareLinkId: string; notAfter: number | undefined };

/**
 * ONE MODE, THREE ORIGINS — decided in one place so the two alias-free flows
 * cannot drift apart.
 *
 *   watch   `#k`. The reviewer already holds the alias; echoing it back
 *           discloses nothing they did not present, and every deployed client
 *           and every pinned compatibility test depends on that byte for byte.
 *   compat  `?r=`. The reviewer holds only a TRANSPORT alias. Echoing the
 *           canonical alias would let one redemption convert the weaker
 *           credential into the permanent one.
 *   resume  holds only a session grant. Same argument, one step further on.
 */
function mediaTokenModeFor(
  origin: ResolvePublicWatchParams["origin"],
  shareLinkId: string,
  notAfter: number | undefined,
): MediaTokenMode {
  return origin === "compat" || origin === "resume"
    ? { kind: "aliasFree", shareLinkId, notAfter }
    : { kind: "credential" };
}

type PublicDatabaseVideoBinaryParams = {
  host: string;
  token: string;
  videoId: string;
  grant?: string | undefined;
  headOnly?: boolean | undefined;
  rangeHeader?: string | undefined;
};

type PublicLocalVideoFileParams = PublicDatabaseVideoBinaryParams;

type PublicLocalThumbnailParams = {
  host: string;
  token: string;
  videoId: string;
  grant?: string | undefined;
};

type RecordPublicVideoViewParams = {
  host: string;
  token: string;
  videoId: string;
  requestMeta?: Pick<PublicWatchRequestMeta, "ip" | "userAgent"> | undefined;
};

export type PublicDatabaseVideoBinary = {
  statusCode: 200 | 206 | 416;
  mimeType: string;
  sizeBytes: number;
  contentLength: number;
  contentRange: string | null;
  data: Buffer | null;
};

export type PublicLocalVideoFile = LocalStorageRangeResult & {
  mimeType: string;
};

export type PublicLocalThumbnail = {
  mimeType: string;
  contentLength: number;
  stream: NodeJS.ReadableStream;
};

/**
 * What the public thumbnail route returns, for any provider.
 *
 * `contentLength` is nullable because an upstream CDN is not obliged to send
 * `Content-Length`. A local asset always has one; a proxied one may not, and
 * the controller must then omit the header rather than emit a wrong number.
 */
export type PublicThumbnail = {
  mimeType: string;
  contentLength: number | null;
  stream: NodeJS.ReadableStream;
};

type PublicBinaryAssetMetadata = {
  mimeType: string;
  sizeBytes: bigint;
};

type PublicLocalAssetMetadata = {
  storageKey?: string;
  mimeType: string;
  sizeBytes: bigint;
};

type PublicWatchVideoWithBinary = VideoAsset & {
  binaryAsset?: PublicBinaryAssetMetadata | null;
  localFileAsset?: PublicLocalAssetMetadata | null;
  localThumbnailAsset?: PublicLocalAssetMetadata | null;
};

type ShareLinkWithVideos = ShareLink & {
  shareLinkVideos: Array<{
    sortOrder: number;
    video: PublicWatchVideoWithBinary;
  }>;
};

type ShareLinkWhereInput = Prisma.Args<
  PrismaService["shareLink"],
  "updateMany"
>["where"];

type ShareLinkViewPolicy = Pick<
  ShareLink,
  "id" | "status" | "expiresAt" | "maxViews" | "currentViews"
>;

type CachedPublicWatchMetadata = {
  website: Pick<Website, "id" | "name" | "slug">;
  shareLink: ShareLinkViewPolicy;
  videos: PublicWatchVideoWithBinary[];
};

@Injectable()
export class PublicService {
  private readonly logger = new Logger(PublicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly localVideoStorageService: LocalVideoStorageService,
    private readonly videoViewGrowthService: VideoViewGrowthService,
    private readonly publicMediaGrantService: PublicMediaGrantService,
    private readonly publicReviewResumeService: PublicReviewResumeService,
    @Optional() private readonly memoryCache?: MemoryCacheService,
    // Appended and optional on purpose. Public watch resolution for every
    // legacy source type must work with no Bunny collaborator at all.
    @Optional() private readonly bunnyStreamService?: BunnyStreamService,
    // Same reasoning, and additionally OFF by default: a deployment that has
    // not opted into the backend-mediated poster keeps its previous behaviour
    // byte for byte.
    @Optional()
    private readonly bunnyThumbnailProxyService?: BunnyThumbnailProxyService,
  ) {}

  async resolvePublicWatch(
    params: ResolvePublicWatchParams,
  ): Promise<PublicWatchResponse> {
    const normalizedHost = normalizePublicHost(params.host);
    const trimmedToken = this.normalizePublicToken(params.token);

    /* THE CACHE MAY CACHE DATA. IT MUST NOT CACHE AUTHORITY.
     *
     * `resolveCachedPublicWatch()` decides status, expiry, membership,
     * assignment and READY from the CACHED ShareLink and video rows. For the
     * legacy `#k` flow that is long-standing, documented, deliberately-bounded
     * behaviour (SECURITY_MODEL §4.2, KI-020) and the release-blocking
     * compatibility suite pins it — so it is left exactly as it was.
     *
     * The two ALIAS-FREE origins are new surface, and they do not get it. A
     * compatibility exchange and a resume both re-read every authorization
     * fact from the database on every request, so a revoke, an expiry, an
     * un-assignment, a membership change, a video leaving READY or a cleared
     * `PUBLIC_COMPATIBILITY_URL_HOSTS` take effect on the NEXT request rather
     * than after a cache TTL. That costs one query per request on a throttled
     * route, and correctness is worth more than the query.
     *
     * Note this also removes the warm-cache branch as a place the origin-
     * specific rules (the non-consuming resume claim, the alias-free media
     * mode) have to be re-implemented — there is now exactly one path that
     * serves them. */
    const mayUseWatchCache = params.origin === undefined || params.origin === "watch";

    if (mayUseWatchCache && normalizedHost !== null && trimmedToken) {
      const cacheKey = this.buildPublicWatchCacheKey(
        normalizedHost,
        trimmedToken,
      );
      const cachedMetadata =
        this.memoryCache?.get<CachedPublicWatchMetadata>(cacheKey) ?? null;

      if (cachedMetadata !== null) {
        const cachedResponse = await this.resolveCachedPublicWatch({
          params,
          cacheKey,
          normalizedHost,
          trimmedToken,
          cachedMetadata,
        });

        if (cachedResponse !== null) {
          return cachedResponse;
        }
      }
    }

    return this.resolvePublicWatchUncached(params);
  }

  /**
   * THE EMAIL-SAFE COMPATIBILITY EXCHANGE.
   *
   * `alias` here is the TRANSPORT alias from `/watch?r=<transportAlias>` — a
   * separate 128-bit identifier, and an ALTERNATE BEARER CREDENTIAL for the
   * same ShareLink. It is never the `#k` credential, and it is never harmless:
   * whoever holds one gets in here. This method does exactly one new thing:
   * it maps that identifier to a ShareLink row and
   * hands the row's OWN `alias` to `resolvePublicWatch()`. Everything that
   * decides whether the reviewer gets in then runs unmodified — host → ACTIVE
   * domain → ACTIVE website → ShareLink WITHIN that website → status, expiry,
   * `maxViews` → membership ∩ ACTIVE assignment → READY/playable → the atomic
   * view claim → access log.
   *
   * ONE EXCEPTION, DELIBERATE: this is an ALIAS-FREE origin (`mediaTokenModeFor()`).
   * The AUTHORIZED CONTENT is identical to a `#k` exchange for the same link —
   * same videos, same titles, same semantic payload — but the PROTECTED
   * BACKEND URLs are not: `#k` echoes the presented credential into every
   * `:token` path segment, while `compat` and `resume` carry a short-lived,
   * per-video `rmv1` media token instead. Echoing the canonical alias back to
   * a caller who presented only a transport alias would let one redemption
   * upgrade the weaker credential into the permanent one — see
   * `PublicReviewResumeService`.
   *
   * WHAT THAT BUYS, AND WHAT IT DELIBERATELY DOES NOT.
   *
   * - One authority. There is no second resolver to drift from the first,
   *   and no rule the `#k` path enforces that this path can skip: the website
   *   scope in particular is re-imposed by the resolver's own
   *   `findFirst({ alias, websiteId })`, so a transport alias for website A
   *   presented on website B's host is refused there, not here.
   * - Parity, not privilege. A successful call consumes one view exactly as
   *   the `#k` exchange does. A denied call consumes nothing.
   * - No fallback. The value handed to the resolver is a share alias (7 or 16
   *   characters); a raw token is `s_` + 43, so the resolver's token-hash
   *   branch can never match some other row.
   * - Disjoint credentials. The transport alias is refused by the V2 resolver
   *   (it matches no `alias` and hashes to no `tokenHash`), and a `#k`
   *   credential is refused here by shape before any read.
   *
   * The response is alias-free. Protected backend media URLs carry per-video
   * rmv1 tokens; neither those URLs nor any response field exposes the
   * ShareLink alias, transport alias, raw token or token hash.
   */
  async resolvePublicWatchCompatible(
    params: ResolvePublicWatchCompatibleParams,
  ): Promise<PublicWatchResponse> {
    const normalizedHost = normalizePublicHost(params.host);

    if (normalizedHost === null) {
      await this.writeAccessLog({
        reasonCode: "MISSING_HOST",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("MISSING_HOST");
    }

    // CAPABILITY BEFORE CREDENTIAL. `PUBLIC_COMPATIBILITY_URL_HOSTS` gates
    // REDEMPTION here as well as emission in the Admin, through the one
    // shared predicate — neither side re-implements the host rule.
    //
    // THIS IS WHAT MAKES THE ALLOWLIST A KILL SWITCH. Gating emission alone
    // would mean clearing the variable stops new URLs being minted while
    // every URL already sitting in a reviewer's inbox keeps working, because
    // a transport alias is a BEARER CREDENTIAL and nothing about it expires.
    // An operator clearing the variable during an incident will believe they
    // have closed the alternate surface; with emission-only gating they would
    // be wrong, and would find out only by reading this method. Now the
    // belief is correct: clear the variable, restart, and every `?r=` link
    // for that host stops resolving at once — while every `#k` link keeps
    // working, which is the point of having a separate lever.
    //
    // It runs BEFORE the shape check and therefore before any credential is
    // examined or read: a host that may not redeem never has its presented
    // secret looked at, let alone queried. The denial is the same generic
    // `INVALID_LINK` every other refusal on this path returns.
    //
    // This is NOT a substitute for revocation. It suspends a whole host's
    // alternate surface; it does not invalidate an individual credential.
    // Restore the host and every previously-issued alias redeems again.
    // Revoking the ShareLink is still the only way to kill one for good.
    if (
      !isCompatibilityCapableHost(
        normalizedHost,
        this.configService.get<string>("PUBLIC_COMPATIBILITY_URL_HOSTS"),
      )
    ) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "INVALID_LINK",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("INVALID_LINK");
    }

    // SHAPE BEFORE STORAGE. Exactly the minted form — no trim, no decode — so
    // garbage costs no query and a `#k` credential can never be looked up
    // as a transport alias.
    if (!isWellFormedTransportAlias(params.alias)) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "INVALID_LINK",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("INVALID_LINK");
    }

    const row = await this.prisma.shareLink.findUnique({
      where: { transportAlias: params.alias },
      select: { alias: true },
    });
    const shareAlias = row?.alias?.trim();

    // Unknown transport alias, or a row that cannot be re-entered into the V2
    // resolver by its own alias: the same generic denial, and nothing else
    // is tried. Never the token hash, never another row.
    if (!shareAlias) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "INVALID_LINK",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("INVALID_LINK");
    }

    return this.resolvePublicWatch({
      host: params.host,
      token: shareAlias,
      requestMeta: params.requestMeta,
      // The one flow that scrubs its carrier, and therefore the only one whose
      // session a refresh would otherwise lose. This is what makes a resume
      // grant appear on the response.
      origin: "compat",
    });
  }

  /**
   * THE REVIEW-RESUME EXCHANGE.
   *
   * A reviewer opened `/watch?r=<transportAlias>`, the page scrubbed the
   * carrier before its first request, and the credential now exists only in a
   * variable that dies with the document. A refresh would lose the session.
   * This restores it from a short-lived grant held in `sessionStorage` — with
   * no share credential in the URL, and without spending a second view.
   *
   * THE GRANT IS A POINTER, NOT A PERMISSION. It names a ShareLink id and the
   * host it was minted on. Everything that decides whether this reviewer may
   * still watch is re-read from the database on THIS request, by handing the
   * row's own `alias` to the unmodified V2 resolver. So a grant that is
   * perfectly valid is still refused when the link was revoked, disabled,
   * expired or exhausted, when the video stopped being READY, when membership
   * or the website assignment was removed, when the domain or website was
   * disabled, or when the host lost its compatibility capability.
   *
   * ORDERED CHEAPEST-FIRST, AND FAIL-CLOSED AT EVERY STEP:
   *
   *   1. host normalization        no host, no work
   *   2. CAPABILITY KILL SWITCH    before the credential is examined at all
   *   3. signature + purpose + host + expiry   no database read yet
   *   4. locate the row by id      the only thing the grant is trusted for
   *   5. the unmodified V2 chain   every authorization fact, re-read
   *
   * Step 2 sits ahead of step 3 deliberately. Clearing
   * `PUBLIC_COMPATIBILITY_URL_HOSTS` is the emergency lever for the whole
   * email-safe surface, and a resume session IS that surface continued — so it
   * has to die with the same switch, on the same request, before any presented
   * secret is even inspected.
   */
  async resolvePublicWatchResume(
    params: ResolvePublicWatchResumeParams,
  ): Promise<PublicWatchResponse> {
    const normalizedHost = normalizePublicHost(params.host);

    if (normalizedHost === null) {
      await this.writeAccessLog({
        reasonCode: "MISSING_HOST",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("MISSING_HOST");
    }

    // THE KILL SWITCH REACHES RESUMED SESSIONS TOO. Without this, clearing the
    // allowlist would stop new `?r=` redemptions while every tab that had
    // already resumed kept working for the life of its grant — which is
    // exactly the false sense of closure the redemption gate was added to
    // prevent on the exchange itself.
    if (
      !isCompatibilityCapableHost(
        normalizedHost,
        this.configService.get<string>("PUBLIC_COMPATIBILITY_URL_HOSTS"),
      )
    ) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "INVALID_LINK",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("INVALID_LINK");
    }

    const claim = this.publicReviewResumeService.verify(params.grant, {
      host: normalizedHost,
    });
    if (claim === null) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "INVALID_LINK",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("INVALID_LINK");
    }

    // The ONE thing the grant is trusted for: which row to look at. `select`
    // is deliberately narrow — the resolver re-reads everything it needs, and
    // a wider select here would invite trusting a value read at this point.
    const row = await this.prisma.shareLink.findUnique({
      where: { id: claim.shareLinkId },
      select: { alias: true },
    });
    const shareAlias = row?.alias?.trim();

    if (!shareAlias) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "INVALID_LINK",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("INVALID_LINK");
    }

    return this.resolvePublicWatch({
      host: params.host,
      token: shareAlias,
      requestMeta: params.requestMeta,
      origin: "resume",
      /* The ceiling for every media token this response mints. A poster URL
         must not outlive the session grant that produced it, or deleting
         `sessionStorage` would stop the reviewer resuming while the URLs
         already in their DOM kept working. */
      resumeNotAfter: claim.expiresAt,
    });
  }

  private async resolvePublicWatchUncached(
    params: ResolvePublicWatchParams,
  ): Promise<PublicWatchResponse> {
    const normalizedHost = normalizePublicHost(params.host);

    if (normalizedHost === null) {
      await this.writeAccessLog({
        reasonCode: "MISSING_HOST",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("MISSING_HOST");
    }

    const domainRecord = await this.prisma.websiteDomain.findUnique({
      where: { domain: normalizedHost },
      include: { website: true },
    });

    if (
      domainRecord === null ||
      domainRecord.website === null ||
      domainRecord.status !== DomainStatus.ACTIVE ||
      domainRecord.website.status !== WebsiteStatus.ACTIVE
    ) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "INVALID_LINK",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("INVALID_LINK");
    }

    const website = domainRecord.website;
    const trimmedToken = this.normalizePublicToken(params.token);

    if (!trimmedToken) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "MISSING_TOKEN",
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("MISSING_TOKEN");
    }

    const tokenPepper = this.configService
      .get<string>("SHARE_TOKEN_PEPPER")
      ?.trim();

    if (!tokenPepper) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "SERVER_ERROR",
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        requestMeta: params.requestMeta,
      });
      this.logger.error("SHARE_TOKEN_PEPPER is missing for public watch.");

      return this.invalidResponse("SERVER_ERROR");
    }

    const tokenHash = hashShareToken({
      pepper: tokenPepper,
      token: trimmedToken,
    });

    const publicWatchInclude = {
      shareLinkVideos: {
        where: {
          video: {
            websiteVideos: {
              some: {
                websiteId: website.id,
                status: AssignmentStatus.ACTIVE,
              },
            },
          },
        },
        orderBy: {
          sortOrder: "asc" as const,
        },
        include: {
          video: {
            include: {
              binaryAsset: {
                select: {
                  mimeType: true,
                  sizeBytes: true,
                },
              },
              localFileAsset: {
                select: {
                  mimeType: true,
                  sizeBytes: true,
                },
              },
              localThumbnailAsset: {
                select: {
                  mimeType: true,
                  sizeBytes: true,
                },
              },
            },
          },
        },
      },
    };

    const shareLink =
      (await this.prisma.shareLink.findFirst({
        where: {
          alias: trimmedToken,
          websiteId: website.id,
        },
        include: publicWatchInclude,
      })) ??
      (await this.prisma.shareLink.findFirst({
        where: {
          tokenHash,
          websiteId: website.id,
        },
        include: publicWatchInclude,
      }));

    if (shareLink === null) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "INVALID_LINK",
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("INVALID_LINK");
    }

    const now = new Date();
    const deniedReason = this.getDeniedReason(shareLink, now);
    if (deniedReason !== null) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: deniedReason,
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        shareLinkId: shareLink.id,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse(deniedReason, website, normalizedHost);
    }

    // SELECTION ONLY - no playback credential is minted here. See
    // `selectPublicPlayableVideos`.
    const playableVideos = this.selectPublicPlayableVideos(
      shareLink.shareLinkVideos.map(({ video }) => video),
    );
    if (playableVideos.length === 0) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "NO_VIDEOS",
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        shareLinkId: shareLink.id,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("NO_VIDEOS", website, normalizedHost);
    }

    // AUTHORITATIVE ATOMIC CONSUMPTION. Everything above is a candidate check;
    // this conditional update re-verifies status, expiry and `maxViews` and
    // claims the view in one statement. Nothing that grants playback may run
    // before it succeeds.
    /* A RESUME CONSUMES NOTHING.
     *
     * A refresh is the SAME review session, not a new one. Counting it would
     * make `currentViews` a measure of how often a reviewer's browser reloaded
     * — and on a budgeted link it would let a page refresh spend somebody
     * else's access.
     *
     * Skipping the claim is safe here precisely because it is not the only
     * check: `getDeniedReason()` above has already re-read this row's status,
     * expiry and budget from the database on THIS request, so a revoked,
     * expired or exhausted link is refused before reaching this point. What
     * the atomic claim adds over that is the race-free decrement, and a path
     * that decrements nothing does not need it.
     *
     * The grant is not what makes this safe. The grant only says WHICH row to
     * look at; every authorization fact was re-read from that row.
     */
    const viewIncremented =
      params.origin === "resume"
        ? true
        : await this.incrementShareLinkView(shareLink, now);
    if (!viewIncremented) {
      const latestShareLink = await this.prisma.shareLink.findUnique({
        where: { id: shareLink.id },
      });
      const latestDeniedReason = latestShareLink
        ? (this.getDeniedReason(latestShareLink, now) ?? "INVALID_LINK")
        : "INVALID_LINK";

      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: latestDeniedReason,
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        shareLinkId: shareLink.id,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse(latestDeniedReason, website, normalizedHost);
    }

    await this.writeAccessLog({
      domain: normalizedHost,
      reasonCode: "OK",
      status: AccessLogStatus.ALLOWED,
      websiteId: website.id,
      shareLinkId: shareLink.id,
      requestMeta: params.requestMeta,
    });
    this.writePublicWatchCache({
      normalizedHost,
      trimmedToken,
      website,
      shareLink,
      now,
    });

    // Consumption succeeded. Only now may playback credentials be minted - and
    // Bunny signing additionally passes the authoritative database gate first.
    const signableBunnyVideoIds =
      await this.loadSignableBunnyVideoIds(playableVideos);

    /* THE SESSION GRANT IS MINTED BEFORE THE PAYLOAD IS SERIALIZED, so the
       media tokens below can be clamped to its expiry. On the compat origin
       this response BOTH consumes the view and establishes the session, and a
       media token that outlived that session would be a credential with
       nothing left to authorize it. */
    const resumeSession = this.mintResumeGrantIfEligible(
      params.origin,
      shareLink,
      normalizedHost,
      now,
    );

    return {
      valid: true,
      reasonCode: "OK",
      website: this.toPublicWebsiteResponse(website, normalizedHost),
      videos: this.toPublicVideoResponses(
        playableVideos,
        {
          host: normalizedHost,
          token: trimmedToken,
          mediaTokenMode: mediaTokenModeFor(
            params.origin,
            shareLink.id,
            resumeSession?.expiresAt ?? params.resumeNotAfter,
          ),
        },
        shareLink,
        signableBunnyVideoIds,
      ),
      /* SPREAD, NOT `?? null`. The key is absent unless this exchange
         actually minted a grant, so the `#k` success body and the legacy
         `GET` body keep exactly the property set they have always had. */
      ...(resumeSession === null ? {} : { resumeGrant: resumeSession.grant }),
    };
  }

  /**
   * A resume grant, but ONLY for the flow that needs one and ONLY after the
   * view has already been claimed.
   *
   * THE ORIGIN GATE IS THE WHOLE RULE, and it is narrow on purpose:
   *
   *   compat  the `?r=` exchange scrubs its carrier from the address bar, so a
   *           refresh has nothing left to redeem. This is the only session a
   *           grant is needed for.
   *   watch   the `#k` flow never scrubs — the fragment stays in the URL and a
   *           refresh re-redeems it unaided. Minting here would put a
   *           credential in storage to solve a problem that does not exist.
   *   resume  already holds one. Re-minting on every refresh would slide the
   *           TTL forward indefinitely and turn an 8-hour credential into a
   *           permanent one.
   *
   * THE BUDGET GATE IS THE SECOND RULE. A grant restores a session WITHOUT
   * consuming a view, so on a budgeted link it would be a way to keep watching
   * after the budget was spent. Canonical links — the only ones the email-safe
   * URL is emitted for — carry neither `maxViews` nor `expiresAt` by contract,
   * so this refuses rather than reasons about a shape that should not arrive.
   */
  private mintResumeGrantIfEligible(
    origin: ResolvePublicWatchParams["origin"],
    shareLink: Pick<ShareLink, "id" | "maxViews" | "expiresAt">,
    normalizedHost: string,
    now: Date,
  ): { grant: string; expiresAt: number } | null {
    if (origin !== "compat") {
      return null;
    }
    if (shareLink.maxViews !== null || shareLink.expiresAt !== null) {
      return null;
    }

    const grant = this.publicReviewResumeService.issue({
      shareLinkId: shareLink.id,
      host: normalizedHost,
      now,
    });
    const claim = this.publicReviewResumeService.verify(grant, {
      host: normalizedHost,
      now,
    });

    /* THE EXPIRY IS READ BACK FROM THE GRANT, not recomputed alongside it.
       The media tokens in this same response are clamped to it, and two
       independent computations of "the same" deadline is exactly how they
       would come to disagree — leaving a poster URL alive after the session
       it belongs to had expired. Reading it back means there is one number.

       `verify()` cannot fail on a grant this method just minted; the null
       branch is a type obligation, and falling back to no clamp would be
       wrong, so it drops the grant instead. */
    return claim === null ? null : { grant, expiresAt: claim.expiresAt };
  }

  async getPublicLocalVideoFile(
    params: PublicLocalVideoFileParams,
  ): Promise<PublicLocalVideoFile> {
    const localFileAsset = await this.getAuthorizedPublicLocalFileAsset(params);

    return {
      mimeType: localFileAsset.mimeType,
      ...this.localVideoStorageService.createRangeReadStream({
        storageKey: localFileAsset.storageKey,
        rangeHeader: params.rangeHeader,
      }),
    };
  }

  async recordPublicVideoView(
    params: RecordPublicVideoViewParams,
  ): Promise<PublicVideoViewResponse> {
    const authorized = await this.getAuthorizedPublicVideoForView(params);

    if (authorized === null) {
      return this.invalidVideoViewResponse();
    }

    const result = await this.videoViewGrowthService.recordPublicVideoView({
      videoId: authorized.video.id,
      shareLinkId: authorized.shareLink.id,
      websiteId: authorized.website.id,
      requestMeta: params.requestMeta,
    });

    return {
      valid: true,
      videoId: result.videoId,
      viewCount: result.viewCount,
      publishedAt: result.publishedAt,
    };
  }

  /**
   * Serves the reviewer-facing poster for one video, whatever provider backs it.
   *
   * ROUTE PRESERVED ON PURPOSE. This is still
   * `GET|HEAD /public/watch/:token/videos/:videoId/thumbnail?host=…[&grant=…]`.
   * A second route would mean a second copy of the authorization chain, and two
   * copies drift; `docs/API_CONTRACTS.md` §3.2 already documents this URL and
   * both public clients already call it.
   *
   * LOCAL_FILE behaviour is byte-identical to before. The Bunny branch is
   * additive and only reachable when the proxy is explicitly enabled.
   */
  async getPublicThumbnail(
    params: PublicLocalThumbnailParams,
  ): Promise<PublicThumbnail> {
    const normalizedHost = normalizePublicHost(params.host);
    const trimmedToken = this.normalizePublicToken(params.token);

    if (
      normalizedHost === null ||
      trimmedToken === null ||
      !this.isValidPublicVideoId(params.videoId) ||
      !this.isValidMediaGrantInput(params.grant)
    ) {
      throw new NotFoundException("Video not found.");
    }

    // LOCAL_FILE FAST PATH, PRESERVED EXACTLY. A cached LOCAL_FILE
    // authorization must keep costing ZERO queries: that cache is the whole
    // point of KI-020/§4.2, and routing every thumbnail through the generic
    // loader first would silently double the query count on a public route.
    // The cached entry carries the video row, so its `sourceType` is enough to
    // dispatch, and the delegation below then hits the very same entry.
    // ...AND NOT FOR AN RMV1 TOKEN, for the reason given in
    // `getAuthorizedPublicLocalVideo()`. This peek only chooses a branch, and
    // the branch it chooses would authorize from the same entry, so skipping
    // it here is what keeps the two consistent. An rmv1 thumbnail therefore
    // takes the fully-authoritative path below on every request.
    const cachedVideo = this.publicReviewResumeService.isMediaToken(
      trimmedToken,
    )
      ? null
      : (this.memoryCache?.get<PublicWatchVideoWithBinary>(
          this.buildPublicLocalMediaMetadataCacheKey(
            normalizedHost,
            trimmedToken,
            params.videoId,
          ),
        ) ?? null);
    if (cachedVideo?.sourceType === VideoSourceType.LOCAL_FILE) {
      return this.getPublicLocalThumbnail(params);
    }

    // The Bunny branch deliberately does NOT consult that cache. A Bunny poster
    // is decided from a FRESH read, for the same reason
    // `loadSignableBunnyVideoIds()` exists — this process's cache cannot be
    // invalidated by reconciliation running anywhere else, so a stale READY row
    // would keep serving a poster for a video Bunny has already deleted. Only
    // LOCAL_FILE entries are ever written to it, so the lookup above can never
    // return a Bunny row.
    const { shareLink, video } = await this.loadAuthorizedPublicMediaVideo({
      normalizedHost,
      trimmedToken,
      videoId: params.videoId,
    });
    if (!this.hasValidMediaGrant(shareLink, params, normalizedHost)) {
      throw new NotFoundException("Video not found.");
    }

    if (video.sourceType === VideoSourceType.LOCAL_FILE) {
      return this.getPublicLocalThumbnail(params);
    }

    return this.getPublicBunnyThumbnail(video);
  }

  /**
   * The Bunny half of the public poster route.
   *
   * THREE INDEPENDENT GATES, all of which must pass, and every failure is the
   * same generic `404 "Video not found."`:
   *
   *   1. AUTHORITATIVE BUNNY IDENTITY. `classifyBunnyVideoAsset()` — the same
   *      strict predicate playback signing uses, not a weaker copy — plus the
   *      absence of `metadataJson.bunnyStream.remoteMissing`. A
   *      `bunny-malformed` record fails closed and never falls through to its
   *      stored URL.
   *   2. URL VALIDATION. The stored `thumbnailUrl` is parsed and every
   *      component checked against the proven identity, then the upstream URL
   *      is REBUILT from that identity. See
   *      `resolveBunnyThumbnailUpstreamUrl()`.
   *   3. UPSTREAM RESPONSE VALIDATION. Status, redirect refusal, content type
   *      and size, in `BunnyThumbnailProxyService`.
   *
   * The caller has already proven the share authorization chain, so nothing
   * about the reviewer's entitlement is decided here.
   */
  private async getPublicBunnyThumbnail(
    video: PublicWatchVideoWithBinary,
  ): Promise<PublicThumbnail> {
    const upstreamUrl = this.resolveBunnyThumbnailUpstream(video);
    if (upstreamUrl === null) {
      throw new NotFoundException("Video not found.");
    }

    const result =
      await this.bunnyThumbnailProxyService!.fetchThumbnail(upstreamUrl);
    if (!result.ok) {
      // The reason is internal diagnostics only. A reviewer must not be able to
      // tell an upstream 403 from an upstream 404 from a size rejection: that
      // is the same non-enumerability rule every other public denial follows.
      this.logger.warn(
        { videoId: video.id, reason: result.reason },
        "Public Bunny thumbnail could not be served.",
      );

      throw new NotFoundException("Video not found.");
    }

    return {
      mimeType: result.contentType,
      contentLength: result.contentLength,
      stream: result.stream,
    };
  }

  /**
   * The upstream Bunny poster URL for a video, or null when there is not one
   * this backend is willing to fetch.
   *
   * Pure and I/O-free, so `toPublicVideoResponses()` can use the SAME decision
   * to choose which URL shape to advertise. If serialization advertised the
   * backend route while the route itself refused, every Bunny card would render
   * a broken image; one function means the two answers cannot disagree.
   */
  private resolveBunnyThumbnailUpstream(
    video: PublicWatchVideoWithBinary,
  ): string | null {
    if (
      this.bunnyThumbnailProxyService === undefined ||
      !this.bunnyThumbnailProxyService.isEnabled() ||
      this.bunnyStreamService === undefined
    ) {
      return null;
    }

    // (1) AUTHORITATIVE IDENTITY. `bunny-malformed` and `not-bunny` both stop
    // here: the first must never reach its stored URL, and the second is not
    // this branch's business.
    const classification = classifyBunnyVideoAsset(video);
    if (classification.kind !== "bunny") {
      return null;
    }

    // Reconciliation has proven the remote asset is gone. Serving its cached
    // poster would advertise a video that cannot play.
    if (isBunnyRemoteMissing(video.metadataJson)) {
      return null;
    }

    const pullZoneHostname = this.bunnyStreamService.getPullZoneHostname();
    if (pullZoneHostname === null) {
      return null;
    }

    // (2) URL VALIDATION against the proven identity, then reconstruction.
    const resolved = resolveBunnyThumbnailUpstreamUrl(video.thumbnailUrl, {
      bunnyVideoId: classification.bunnyVideoId,
      pullZoneHostname,
    });

    return resolved.ok ? resolved.url : null;
  }

  async getPublicLocalThumbnail(
    params: PublicLocalThumbnailParams,
  ): Promise<PublicLocalThumbnail> {
    const localThumbnailAsset =
      await this.getAuthorizedPublicLocalThumbnailAsset(params);
    const result = this.localVideoStorageService.createFullReadStream(
      localThumbnailAsset.storageKey,
    );

    return {
      mimeType: localThumbnailAsset.mimeType,
      contentLength: result.contentLength,
      stream: result.stream,
    };
  }

  async getPublicDatabaseVideoBinary(
    params: PublicDatabaseVideoBinaryParams,
  ): Promise<PublicDatabaseVideoBinary> {
    const binaryAsset =
      await this.getAuthorizedPublicDatabaseBinaryAsset(params);
    const totalSize = Number(binaryAsset.sizeBytes);

    if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
      throw new NotFoundException("Video not found.");
    }

    const range = this.parseRangeHeader(params.rangeHeader, totalSize);

    if (range === null) {
      return {
        statusCode: 416,
        mimeType: binaryAsset.mimeType,
        sizeBytes: totalSize,
        contentLength: 0,
        contentRange: `bytes */${totalSize}`,
        data: null,
      };
    }

    const data = params.headOnly
      ? null
      : await this.readDatabaseVideoBinaryChunk(
          params.videoId,
          range.start,
          range.length,
        );

    return {
      statusCode: range.statusCode,
      mimeType: binaryAsset.mimeType,
      sizeBytes: totalSize,
      contentLength: data?.length ?? range.length,
      contentRange:
        range.statusCode === 206
          ? `bytes ${range.start}-${range.end}/${totalSize}`
          : null,
      data,
    };
  }

  private async resolveCachedPublicWatch(params: {
    params: ResolvePublicWatchParams;
    cacheKey: string;
    normalizedHost: string;
    trimmedToken: string;
    cachedMetadata: CachedPublicWatchMetadata;
  }): Promise<PublicWatchResponse | null> {
    const now = new Date();
    const deniedReason = this.getDeniedReason(
      params.cachedMetadata.shareLink,
      now,
    );
    if (deniedReason !== null) {
      this.memoryCache?.delete(params.cacheKey);
      return null;
    }

    // A cache hit accelerates LOOKUP only. It must not shortcut the ordering:
    // selection first, authoritative consumption second, signing last.
    const playableVideos = this.selectPublicPlayableVideos(
      params.cachedMetadata.videos,
    );
    if (playableVideos.length === 0) {
      this.memoryCache?.delete(params.cacheKey);
      return null;
    }

    const viewIncremented =
      params.params.origin === "resume"
        ? true
        : await this.incrementShareLinkView(
            params.cachedMetadata.shareLink,
            now,
          );
    if (!viewIncremented) {
      this.memoryCache?.delete(params.cacheKey);
      // Re-runs the full chain, which denies without signing.
      return this.resolvePublicWatchUncached(params.params);
    }

    await this.writeAccessLog({
      domain: params.normalizedHost,
      reasonCode: "OK",
      status: AccessLogStatus.ALLOWED,
      websiteId: params.cachedMetadata.website.id,
      shareLinkId: params.cachedMetadata.shareLink.id,
      requestMeta: params.params.requestMeta,
    });

    /* Defensive construction retained for byte compatibility with the legacy
       cache implementation. The caller admits only `watch`/undefined here;
       compatibility and resume never reach this branch, so it never mints an
       alias-free response or a resume grant from cached metadata. */
    const resumeSession = this.mintResumeGrantIfEligible(
      params.params.origin,
      params.cachedMetadata.shareLink,
      params.normalizedHost,
      now,
    );

    // Consumption succeeded. Signing happens here, per request, so a cache hit
    // still yields a freshly signed Bunny URL rather than a replayed one.
    //
    // AND the cached rows do not get the final say. This process's cache cannot
    // be invalidated by reconciliation running elsewhere, so Bunny signing is
    // gated on a fresh read of the current database rows.
    const signableBunnyVideoIds =
      await this.loadSignableBunnyVideoIds(playableVideos);

    return {
      valid: true,
      reasonCode: "OK",
      website: this.toPublicWebsiteResponse(
        params.cachedMetadata.website,
        params.normalizedHost,
      ),
      videos: this.toPublicVideoResponses(
        playableVideos,
        {
          host: params.normalizedHost,
          token: params.trimmedToken,
          mediaTokenMode: mediaTokenModeFor(
            params.params.origin,
            params.cachedMetadata.shareLink.id,
            resumeSession?.expiresAt ?? params.params.resumeNotAfter,
          ),
        },
        undefined,
        signableBunnyVideoIds,
      ),
      ...(resumeSession === null ? {} : { resumeGrant: resumeSession.grant }),
    };
  }

  private writePublicWatchCache(params: {
    normalizedHost: string;
    trimmedToken: string;
    website: Pick<Website, "id" | "name" | "slug">;
    shareLink: ShareLinkWithVideos;
    now: Date;
  }): void {
    if (this.memoryCache === undefined) {
      return;
    }

    const ttlSeconds =
      this.memoryCache.getRuntimeConfig().publicWatchMetadataTtlSeconds;
    if (
      !this.canCachePublicWatchShareLink(
        params.shareLink,
        params.now,
        ttlSeconds,
      )
    ) {
      return;
    }

    const videos = params.shareLink.shareLinkVideos
      .map(({ video }) => video)
      .filter((video) => this.isPublicPlayableVideo(video));
    if (videos.length === 0) {
      return;
    }

    this.memoryCache.set(
      this.buildPublicWatchCacheKey(params.normalizedHost, params.trimmedToken),
      {
        website: {
          id: params.website.id,
          name: params.website.name,
          slug: params.website.slug,
        },
        shareLink: {
          id: params.shareLink.id,
          status: params.shareLink.status,
          expiresAt: params.shareLink.expiresAt,
          maxViews: params.shareLink.maxViews,
          currentViews: params.shareLink.currentViews,
        },
        videos,
      } satisfies CachedPublicWatchMetadata,
      { ttlSeconds },
    );
  }

  private canCachePublicWatchShareLink(
    shareLink: ShareLink,
    now: Date,
    ttlSeconds: number,
  ): boolean {
    if (shareLink.status !== ShareLinkStatus.ACTIVE) {
      return false;
    }

    if (shareLink.maxViews !== null) {
      return false;
    }

    if (
      shareLink.expiresAt !== null &&
      shareLink.expiresAt.getTime() - now.getTime() <= ttlSeconds * 1000
    ) {
      return false;
    }

    return true;
  }

  private buildPublicWatchCacheKey(host: string, tokenOrAlias: string): string {
    return buildCacheKey("public:watch", host, hashCacheKeyPart(tokenOrAlias));
  }

  private buildPublicLocalMediaMetadataCacheKey(
    host: string,
    tokenOrAlias: string,
    videoId: string,
  ): string {
    return buildCacheKey(
      "media:metadata:public:local-video",
      host,
      hashCacheKeyPart(tokenOrAlias),
      videoId,
    );
  }

  private getDeniedReason(
    shareLink: ShareLinkViewPolicy,
    now: Date,
  ): PublicWatchReasonCode | null {
    if (shareLink.status !== ShareLinkStatus.ACTIVE) {
      return "INVALID_LINK";
    }

    if (shareLink.expiresAt !== null && shareLink.expiresAt <= now) {
      return "EXPIRED_LINK";
    }

    if (
      shareLink.maxViews !== null &&
      shareLink.currentViews >= shareLink.maxViews
    ) {
      return "VIEW_LIMIT_REACHED";
    }

    return null;
  }

  private async incrementShareLinkView(
    shareLink: ShareLinkViewPolicy,
    now: Date,
  ): Promise<boolean> {
    const where: ShareLinkWhereInput = {
      id: shareLink.id,
      status: ShareLinkStatus.ACTIVE,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(shareLink.maxViews !== null
        ? { currentViews: { lt: shareLink.maxViews } }
        : {}),
    };

    const result = await this.prisma.shareLink.updateMany({
      where,
      data: {
        currentViews: {
          increment: 1,
        },
        lastViewedAt: now,
      },
    });

    return result.count === 1;
  }

  /**
   * Narrows a candidate list to the videos that are publicly playable.
   *
   * SIGNS NOTHING. This runs BEFORE the authoritative view consumption, so it
   * must never mint a playback credential - it only answers "could this be
   * served?". Bunny playability is therefore decided by
   * `BunnyStreamService.canSignEmbedUrl()`, a pure configuration check, not by
   * attempting a signature.
   */
  private selectPublicPlayableVideos(
    videos: PublicWatchVideoWithBinary[],
  ): PublicWatchVideoWithBinary[] {
    return videos.filter((video) => this.isPublicPlayableVideo(video));
  }

  /**
   * Serializes the public video payload, minting playback credentials.
   *
   * MUST ONLY BE CALLED AFTER the authoritative atomic view consumption has
   * succeeded. It issues HMAC media grants and signs Bunny embed URLs; a
   * request whose consumption failed must never reach this method.
   */
  private toPublicVideoResponses(
    videos: PublicWatchVideoWithBinary[],
    playbackContext: {
      host: string;
      token: string;
      /**
       * How the `:token` path segment of every backend media URL is filled.
       *
       * Defaults to echoing the presented credential for the historical `#k`
       * contract. Compatibility and resume pass `aliasFree`, so no canonical
       * alias appears anywhere in either response.
       */
      mediaTokenMode?: MediaTokenMode | undefined;
    },
    shareLink: Pick<ShareLink, "id" | "maxViews" | "expiresAt"> | undefined,
    /**
     * Result of the authoritative database gate, computed by the caller after
     * consumption. Deliberately REQUIRED: a caller that forgot it would
     * otherwise silently sign from cached state. An empty map signs nothing.
     */
    signableBunnyVideoIds: Map<string, string>,
  ): PublicWatchVideoResponse[] {
    const mediaTokenMode: MediaTokenMode = playbackContext.mediaTokenMode ?? {
      kind: "credential",
    };

    return this.selectPublicPlayableVideos(videos).map((video) => {
      /* THE ONE VALUE THAT DECIDES WHETHER THIS RESPONSE LEAKS THE ALIAS.
         Historical `#k` echoes its presented credential, unchanged.
         Compatibility and resume use a fresh per-video rmv1 token that names
         the row, is host/video scoped, and expires with the review session. */
      const mediaToken =
        mediaTokenMode.kind === "aliasFree"
          ? this.publicReviewResumeService.issueMediaToken({
              shareLinkId: mediaTokenMode.shareLinkId,
              videoId: video.id,
              host: playbackContext.host,
              notAfter: mediaTokenMode.notAfter,
            })
          : playbackContext.token;
      const grant =
        shareLink === undefined || shareLink.maxViews === null
          ? undefined
          : this.publicMediaGrantService.issue({
              shareLinkId: shareLink.id,
              videoId: video.id,
              host: playbackContext.host,
              shareLinkExpiresAt: shareLink.expiresAt,
            });
      const binaryPlaybackUrl =
        video.sourceType === VideoSourceType.DB_BLOB
          ? this.buildPublicBinaryPlaybackUrl({
              token: mediaToken,
              videoId: video.id,
              host: playbackContext.host,
              grant,
            })
          : null;
      const localPlaybackUrl =
        video.sourceType === VideoSourceType.LOCAL_FILE
          ? this.buildPublicLocalPlaybackUrl({
              token: mediaToken,
              videoId: video.id,
              host: playbackContext.host,
              grant,
            })
          : null;
      const localThumbnailUrl =
        video.sourceType === VideoSourceType.LOCAL_FILE &&
        this.isPlayableImageAsset(video.localThumbnailAsset ?? null)
          ? this.buildPublicThumbnailUrl({
              token: mediaToken,
              videoId: video.id,
              host: playbackContext.host,
              grant,
            })
          : null;
      // BUNNY POSTERS ARE BACKEND-MEDIATED.
      //
      // The raw pull-zone URL used to go straight to the reviewer's browser,
      // which is why every poster 403'''d behind Worldfold'''s
      // `Referrer-Policy: no-referrer`: the browser sent no `Referer` and
      // Bunny'''s hotlink protection refused. Returning THIS API'''s route
      // instead makes poster delivery independent of any browser referrer
      // policy, keeps the reviewer'''s IP away from Bunny, and puts the poster
      // behind the same share authorization as everything else.
      //
      // `resolveBunnyThumbnailUpstream()` is the SAME function the route uses,
      // so a URL is only advertised when the route would actually serve it.
      const bunnyThumbnailUrl =
        video.sourceType !== VideoSourceType.LOCAL_FILE &&
        signableBunnyVideoIds.has(video.id) &&
        // The SAME authoritative gate the embed URL is signed behind, reused at
        // no extra cost: it was already computed for this response. Without it
        // a stale cached row could advertise a poster URL while the route — which
        // re-reads the current row — refuses it, leaving a broken image next to
        // a correctly-null `embedUrl`.
        this.resolveBunnyThumbnailUpstream(video) !== null
          ? this.buildPublicThumbnailUrl({
              token: mediaToken,
              videoId: video.id,
              host: playbackContext.host,
              grant,
            })
          : null;
      const thumbnailUrl =
        video.sourceType === VideoSourceType.LOCAL_FILE
          ? localThumbnailUrl
          : (bunnyThumbnailUrl ?? this.toSafePublicBunnyAwareUrl(video));
      // Bunny-backed assets only. Every other source type - including a
      // legacy `provider: BUNNY` DIRECT_URL record - falls through with
      // `video.embedUrl` untouched.
      const embedUrl = this.resolvePublicEmbedUrl(video, signableBunnyVideoIds);

      return {
        id: video.id,
        title: video.title,
        description: video.description,
        sourceType: video.sourceType,
        playbackUrl:
          video.sourceType === VideoSourceType.DB_BLOB ||
          video.sourceType === VideoSourceType.LOCAL_FILE
            ? null
            : this.toSafePublicMediaUrl(video.playbackUrl),
        binaryPlaybackUrl,
        publicPlaybackUrl:
          video.sourceType === VideoSourceType.DB_BLOB
            ? binaryPlaybackUrl
            : localPlaybackUrl,
        binaryAsset:
          video.sourceType === VideoSourceType.DB_BLOB
            ? this.toPublicBinaryAssetResponse(video.binaryAsset ?? null)
            : null,
        localFileAsset:
          video.sourceType === VideoSourceType.LOCAL_FILE
            ? this.toPublicLocalAssetResponse(video.localFileAsset ?? null)
            : null,
        embedUrl,
        embedProvider: video.embedProvider,
        embedAllow: video.embedAllow,
        thumbnailUrl,
        // Both fields carry the same value for a proxied Bunny poster.
        // `private-share-contract.js` in Worldfold reads `publicThumbnailUrl`
        // first and falls back to `thumbnailUrl`, while older public bundles
        // read only `thumbnailUrl`; populating both is what lets an
        // already-deployed client pick up the protected URL with no change.
        publicThumbnailUrl:
          video.sourceType === VideoSourceType.LOCAL_FILE
            ? localThumbnailUrl
            : thumbnailUrl,
        durationSeconds: video.durationSeconds,
        viewCount: video.viewCount.toString(),
        publishedAt: video.publishedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * AUTHORITATIVE DATABASE GATE for Bunny playback signing.
   *
   * WHY THIS EXISTS - and why a cache invalidation cannot replace it.
   *
   * `MemoryCacheService` is PROCESS-LOCAL. Reconciliation that runs anywhere
   * else - `yarn reconcile:bunny --apply`, a second API worker, a manual
   * database fix - commits `status = FAILED` + `remoteMissing` to the database
   * but has no way to reach this process's `public:watch:` entries. Without
   * this gate, a cached READY row would keep minting fresh signed Bunny URLs
   * for a video Bunny has already deleted, for as long as the entry lives.
   *
   * So public Bunny signing no longer trusts cached metadata for the decision
   * that matters. Immediately before a token is minted, the CURRENT row is
   * re-read from the database and must still satisfy every condition:
   *
   *   1. the `VideoAsset` still exists;
   *   2. `status === READY`;
   *   3. it still passes the existing strict `classifyBunnyVideoAsset()`
   *      predicate - the same one used everywhere else, not a weaker copy;
   *   4. `metadataJson.bunnyStream.remoteMissing` is absent;
   *   5. the authoritative Bunny video id equals the one the cached row asked
   *      to sign.
   *
   * Anything else FAILS CLOSED: the video is simply absent from the returned
   * map, `resolvePublicEmbedUrl()` emits `null`, and no token is minted. It
   * never falls back to the stored unsigned `embedUrl`.
   *
   * PERFORMANCE. **ONE** batched, primary-key-indexed local query for the whole
   * response, and only when the share actually contains a Bunny-backed video -
   * a share with none issues no query at all. It performs **no** Bunny
   * Management API request: remote existence remains eventual-consistency state
   * maintained by sync and reconciliation, never re-validated per view.
   *
   * ORDERING. Called by both resolution paths strictly AFTER the atomic view
   * consumption has claimed the view, preserving the existing invariant. If the
   * gate then refuses because the asset became unavailable concurrently, the
   * view is still spent - deliberately. Spending one view is strictly better
   * than issuing playback for a known-unavailable asset.
   *
   * Returns videoId -> authoritative Bunny video id for the assets that may be
   * signed right now.
   */
  private async loadSignableBunnyVideoIds(
    videos: PublicWatchVideoWithBinary[],
  ): Promise<Map<string, string>> {
    // Candidates are decided from the cached rows only so the query stays
    // small; the database is what decides whether each one may actually sign.
    const candidateIds = videos
      .filter((video) => classifyBunnyVideoAsset(video).kind === "bunny")
      .map((video) => video.id);

    if (candidateIds.length === 0) {
      return new Map();
    }

    let currentRows: Array<{
      id: string;
      status: VideoStatus;
      provider: VideoProvider;
      sourceType: VideoSourceType;
      providerAssetId: string | null;
      playbackId: string | null;
      metadataJson: Prisma.JsonValue | null;
    }>;

    try {
      currentRows = await this.prisma.videoAsset.findMany({
        where: { id: { in: candidateIds } },
        select: {
          id: true,
          status: true,
          provider: true,
          sourceType: true,
          providerAssetId: true,
          // Part of the Bunny identification predicate - see
          // `classifyBunnyVideoAsset()`.
          playbackId: true,
          metadataJson: true,
        },
      });
    } catch (error) {
      // FAIL CLOSED on a database error too. Returning an empty map costs a
      // Bunny video its playback for this request; assuming the cached row is
      // still valid could hand out a token for a deleted asset.
      this.logger.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Authoritative Bunny signing gate could not read the current video rows.",
      );

      return new Map();
    }

    const signable = new Map<string, string>();

    for (const row of currentRows) {
      // (2) Current status, read from the database - not from the cache.
      if (row.status !== VideoStatus.READY) {
        continue;
      }

      // (4) Reconciled as gone from Bunny.
      if (isBunnyRemoteMissing(row.metadataJson)) {
        continue;
      }

      // (3) The same strict predicate as every other Bunny branch.
      const classification = classifyBunnyVideoAsset(row);
      if (classification.kind !== "bunny") {
        continue;
      }

      signable.set(row.id, classification.bunnyVideoId);
    }

    // (1) A row that no longer exists is simply absent from `currentRows`, so
    // it never reaches the map and fails closed by construction.
    return signable;
  }

  /**
   * Mints the embed URL the public browser is allowed to see.
   *
   * AUTHORIZATION AND CONSUMPTION BEFORE SIGNING. This runs inside
   * `toPublicVideoResponses`, which is only ever reached after the full chain
   * has passed - host → `ACTIVE` domain → `ACTIVE` website → share link found
   * within that website → status / expiry / `maxViews` → `ShareLinkVideo`
   * membership → `ACTIVE` `WebsiteVideo` assignment → `READY` - **and** after
   * `incrementShareLinkView()` has atomically claimed the view. There is no
   * other caller and no other path to a signed Bunny URL.
   *
   * It runs on every resolution, including cached-metadata hits, because the
   * watch cache stores raw video rows rather than serialized responses. A
   * viewer reloading a valid share page therefore receives a newly signed URL.
   *
   * FAIL CLOSED for the Bunny EMBED shape: a `bunny-malformed` record returns
   * `null` rather than its stored unsigned `embedUrl`. For everything else -
   * ordinary `EMBED`, legacy `provider: BUNNY` `DIRECT_URL`, Cloudinary,
   * `LOCAL_FILE`, `DB_BLOB` - the stored value is returned unchanged.
   */
  private resolvePublicEmbedUrl(
    video: PublicWatchVideoWithBinary,
    signableBunnyVideoIds: Map<string, string>,
  ): string | null {
    const classification = classifyBunnyVideoAsset(video);

    if (classification.kind === "not-bunny") {
      return video.embedUrl;
    }

    if (classification.kind === "bunny-malformed") {
      // Never emit the stored unsigned Bunny URL. `isPublicPlayableVideo()`
      // already filtered this record out; this is the second line of defence.
      return null;
    }

    // AUTHORITATIVE GATE - see `loadSignableBunnyVideoIds()`. Absent means the
    // current database row failed at least one condition, so this request must
    // mint nothing, whatever the cached row said.
    const authoritativeBunnyVideoId = signableBunnyVideoIds.get(video.id);
    if (authoritativeBunnyVideoId === undefined) {
      return null;
    }

    // (5) Identifier agreement. A cached row pointing at a different Bunny
    // video than the one the database now holds must never be signed - with
    // either id.
    if (authoritativeBunnyVideoId !== classification.bunnyVideoId) {
      this.logger.warn(
        { videoId: video.id },
        "Cached Bunny video id no longer matches the stored record; refusing to sign.",
      );

      return null;
    }

    return this.signBunnyEmbedUrl(classification.bunnyVideoId, video.id);
  }

  /**
   * Whether a Bunny embed URL could be signed right now.
   *
   * MINTS NOTHING. Used by `isPublicPlayableVideo()`, which runs before the
   * authoritative view consumption and therefore must not produce a playback
   * credential.
   */
  private canSignBunnyEmbedUrl(): boolean {
    return this.bunnyStreamService?.canSignEmbedUrl() === true;
  }

  /**
   * Signs a short-lived Bunny embed URL, or returns null when it cannot.
   *
   * Fail closed: if Bunny is disabled or misconfigured the caller emits `null`
   * rather than the stored unsigned URL, which would hand out a permanent,
   * unauthorized Bunny link.
   *
   * MUST ONLY BE CALLED AFTER the atomic view consumption has succeeded.
   */
  private signBunnyEmbedUrl(
    bunnyVideoId: string,
    videoId: string,
  ): string | null {
    if (!this.canSignBunnyEmbedUrl() || this.bunnyStreamService === undefined) {
      return null;
    }

    try {
      return this.bunnyStreamService.createSignedEmbedUrl(
        bunnyVideoId,
        new Date(),
        PUBLIC_BUNNY_PLAYER_PARAMS,
      ).embedUrl;
    } catch (error) {
      this.logger.error(
        {
          videoId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Bunny Stream embed signing failed during public watch resolution.",
      );

      return null;
    }
  }

  private isPublicPlayableVideo(video: PublicWatchVideoWithBinary): boolean {
    if (video.status !== VideoStatus.READY) {
      return false;
    }

    if (video.sourceType === VideoSourceType.EMBED) {
      const classification = classifyBunnyVideoAsset(video);

      // A record that structurally claims to be a new-style Bunny asset but
      // fails the predicate is never publicly playable. It must not fall
      // through to generic embed handling, which would serve its stored
      // unsigned Bunny URL.
      if (classification.kind === "bunny-malformed") {
        return false;
      }

      // A valid Bunny asset is playable only while a signature could actually
      // be produced. This is a pure configuration check - it mints nothing -
      // because this method runs BEFORE the atomic view consumption.
      if (classification.kind === "bunny") {
        return this.canSignBunnyEmbedUrl();
      }

      return video.embedUrl !== null && video.embedUrl.trim() !== "";
    }

    if (video.sourceType === VideoSourceType.DB_BLOB) {
      return this.isPlayableBinaryAsset(video.binaryAsset ?? null);
    }

    if (video.sourceType === VideoSourceType.LOCAL_FILE) {
      return this.isPlayableLocalAsset(video.localFileAsset ?? null);
    }

    return video.playbackUrl !== null && video.playbackUrl.trim() !== "";
  }

  private toPublicBinaryAssetResponse(
    binaryAsset: PublicBinaryAssetMetadata | null,
  ): { mimeType: string; sizeBytes: string } | null {
    if (!this.isPlayableBinaryAsset(binaryAsset)) {
      return null;
    }

    return {
      mimeType: binaryAsset.mimeType,
      sizeBytes: binaryAsset.sizeBytes.toString(),
    };
  }

  private toPublicLocalAssetResponse(
    localAsset: PublicLocalAssetMetadata | null,
  ): { mimeType: string; sizeBytes: string } | null {
    if (!this.isPlayableLocalAsset(localAsset)) {
      return null;
    }

    return {
      mimeType: localAsset.mimeType,
      sizeBytes: localAsset.sizeBytes.toString(),
    };
  }

  private async getAuthorizedPublicDatabaseBinaryAsset(
    params: PublicDatabaseVideoBinaryParams,
  ): Promise<PublicBinaryAssetMetadata> {
    const normalizedHost = normalizePublicHost(params.host);
    const trimmedToken = this.normalizePublicToken(params.token);

    if (
      normalizedHost === null ||
      trimmedToken === null ||
      !this.isValidPublicVideoId(params.videoId) ||
      !this.isValidMediaGrantInput(params.grant)
    ) {
      throw new NotFoundException("Video not found.");
    }

    const domainRecord = await this.prisma.websiteDomain.findUnique({
      where: { domain: normalizedHost },
      include: { website: true },
    });

    if (
      domainRecord === null ||
      domainRecord.website === null ||
      domainRecord.status !== DomainStatus.ACTIVE ||
      domainRecord.website.status !== WebsiteStatus.ACTIVE
    ) {
      throw new NotFoundException("Video not found.");
    }

    const tokenPepper = this.configService
      .get<string>("SHARE_TOKEN_PEPPER")
      ?.trim();

    if (!tokenPepper) {
      this.logger.error("SHARE_TOKEN_PEPPER is missing for public DB video.");
      throw new NotFoundException("Video not found.");
    }

    const tokenHash = hashShareToken({
      pepper: tokenPepper,
      token: trimmedToken,
    });

    const binaryInclude = {
      shareLinkVideos: {
        where: {
          videoId: params.videoId,
          video: {
            websiteVideos: {
              some: {
                websiteId: domainRecord.website.id,
                status: AssignmentStatus.ACTIVE,
              },
            },
          },
        },
        take: 1,
        include: {
          video: {
            include: {
              binaryAsset: {
                select: {
                  mimeType: true,
                  sizeBytes: true,
                },
              },
            },
          },
        },
      },
    };

    const credentialKind = this.resolveMediaCredentialKind(
      trimmedToken,
      normalizedHost,
      params.videoId,
    );
    if (credentialKind === null) {
      throw new NotFoundException("Video not found.");
    }

    /* THE WEBSITE SCOPE IS RE-IMPOSED FROM THE DATABASE on both branches.
       A resume media token names a ShareLink id, and the id alone would be
       enough to reach the row — so the lookup is still scoped to the website
       resolved from the request host. The token's own `host` claim was
       checked a moment ago; this is the independent check, and it is the one
       that survives a forged claim. */
    const shareLink =
      credentialKind.kind === "resume"
        ? await this.prisma.shareLink.findFirst({
            where: {
              id: credentialKind.shareLinkId,
              websiteId: domainRecord.website.id,
            },
            include: binaryInclude,
          })
        : ((await this.prisma.shareLink.findFirst({
            where: {
              alias: trimmedToken,
              websiteId: domainRecord.website.id,
            },
            include: binaryInclude,
          })) ??
          (await this.prisma.shareLink.findFirst({
            where: {
              tokenHash,
              websiteId: domainRecord.website.id,
            },
            include: binaryInclude,
          })));

    if (
      shareLink === null ||
      this.getDeniedReasonForMediaPlayback(shareLink, new Date()) !== null ||
      !this.hasValidMediaGrant(shareLink, params, normalizedHost)
    ) {
      throw new NotFoundException("Video not found.");
    }

    const video = shareLink.shareLinkVideos[0]?.video;
    const binaryAsset = video?.binaryAsset ?? null;

    if (
      video === undefined ||
      video.status !== VideoStatus.READY ||
      video.sourceType !== VideoSourceType.DB_BLOB ||
      !this.isPlayableBinaryAsset(binaryAsset)
    ) {
      throw new NotFoundException("Video not found.");
    }

    return binaryAsset;
  }

  private getDeniedReasonForMediaPlayback(
    shareLink: ShareLink,
    now: Date,
  ): PublicWatchReasonCode | null {
    if (shareLink.status !== ShareLinkStatus.ACTIVE) {
      return "INVALID_LINK";
    }

    if (shareLink.expiresAt !== null && shareLink.expiresAt <= now) {
      return "EXPIRED_LINK";
    }

    return null;
  }

  private async getAuthorizedPublicLocalFileAsset(
    params: PublicLocalVideoFileParams,
  ): Promise<Required<PublicLocalAssetMetadata>> {
    const video = await this.getAuthorizedPublicLocalVideo(params);
    const localFileAsset = video?.localFileAsset ?? null;

    if (
      !this.isPlayableLocalAsset(localFileAsset) ||
      !localFileAsset.storageKey
    ) {
      throw new NotFoundException("Video not found.");
    }

    return localFileAsset as Required<PublicLocalAssetMetadata>;
  }

  private async getAuthorizedPublicLocalThumbnailAsset(
    params: PublicLocalThumbnailParams,
  ): Promise<Required<PublicLocalAssetMetadata>> {
    const video = await this.getAuthorizedPublicLocalVideo(params);
    const localThumbnailAsset = video?.localThumbnailAsset ?? null;

    if (
      !this.isPlayableImageAsset(localThumbnailAsset) ||
      !localThumbnailAsset.storageKey
    ) {
      throw new NotFoundException("Video not found.");
    }

    return localThumbnailAsset as Required<PublicLocalAssetMetadata>;
  }

  private async getAuthorizedPublicLocalVideo(params: {
    host: string;
    token: string;
    videoId: string;
    grant?: string | undefined;
  }): Promise<PublicWatchVideoWithBinary> {
    const normalizedHost = normalizePublicHost(params.host);
    const trimmedToken = this.normalizePublicToken(params.token);

    if (
      normalizedHost === null ||
      trimmedToken === null ||
      !this.isValidPublicVideoId(params.videoId) ||
      !this.isValidMediaGrantInput(params.grant)
    ) {
      throw new NotFoundException("Video not found.");
    }

    /* AN RMV1 TOKEN IS NEVER SERVED FROM THIS CACHE.
     *
     * The entry is keyed on a hash of the presented token, so a first request
     * with a given token would warm it and every later request with the SAME
     * token would return before `resolveMediaCredentialKind()` ran — before
     * the signature was verified, before the token's own expiry was checked,
     * before the compatibility kill switch, and before any current database
     * read. A token would then outlive its own `exp`, and clearing
     * `PUBLIC_COMPATIBILITY_URL_HOSTS` would leave already-issued media URLs
     * working for the rest of the cache TTL — which is exactly the false sense
     * of closure this whole surface has been hardened against twice already.
     *
     * A legacy authorized-media cache entry is NOT authorization for an rmv1
     * request, so the read is skipped and the write with it: a per-session
     * token's entry could never be reused by anyone else, and writing one
     * would only evict entries that can be.
     *
     * `#k` and raw-token caching are untouched. */
    const aliasFreeToken =
      this.publicReviewResumeService.isMediaToken(trimmedToken);
    const cacheKey = this.buildPublicLocalMediaMetadataCacheKey(
      normalizedHost,
      trimmedToken,
      params.videoId,
    );
    const cachedVideo = aliasFreeToken
      ? null
      : (this.memoryCache?.get<PublicWatchVideoWithBinary>(cacheKey) ?? null);
    if (cachedVideo !== null) {
      return cachedVideo;
    }

    const { shareLink, video } = await this.loadAuthorizedPublicLocalVideo({
      normalizedHost,
      trimmedToken,
      videoId: params.videoId,
    });
    if (!this.hasValidMediaGrant(shareLink, params, normalizedHost)) {
      throw new NotFoundException("Video not found.");
    }
    const ttlSeconds =
      this.memoryCache?.getRuntimeConfig().mediaMetadataTtlSeconds ?? null;
    if (
      !aliasFreeToken &&
      this.memoryCache !== undefined &&
      ttlSeconds !== null &&
      this.canCachePublicWatchShareLink(shareLink, new Date(), ttlSeconds)
    ) {
      this.memoryCache.set(cacheKey, video, { ttlSeconds });
    }

    return video;
  }

  /**
   * THE PROVIDER-INDEPENDENT PUBLIC MEDIA AUTHORIZATION CHAIN.
   *
   * One implementation, so a second media route cannot drift away from it. It
   * proves, in this order and with no shortcuts:
   *
   *   normalized host -> ACTIVE `WebsiteDomain` -> ACTIVE `Website`
   *   -> a ShareLink belonging to THAT website, matched by alias or peppered
   *      token hash -> ShareLink ACTIVE and not expired
   *   -> `ShareLinkVideo` membership for the exact requested video
   *   -> ACTIVE `WebsiteVideo` assignment of that video to that website
   *   -> `VideoStatus.READY`
   *
   * It deliberately stops there. PROVIDER-SPECIFIC asset validity is the
   * caller's job — `isPlayableLocalAsset()` for LOCAL_FILE, the authoritative
   * Bunny gate for a Bunny poster — because those are different questions with
   * different fail-closed rules, and folding them in here is how one branch
   * quietly becomes weaker than the other.
   *
   * INCREMENTS NOTHING. Media routes never consume a view: the view was claimed
   * once, atomically, when the watch was resolved. `maxViews` is re-checked by
   * the caller through `hasValidMediaGrant()`, which verifies the HMAC grant
   * rather than spending another view.
   */
  private async loadAuthorizedPublicMediaVideo(params: {
    normalizedHost: string;
    trimmedToken: string;
    videoId: string;
  }): Promise<{ shareLink: ShareLink; video: PublicWatchVideoWithBinary }> {
    const domainRecord = await this.prisma.websiteDomain.findUnique({
      where: { domain: params.normalizedHost },
      include: { website: true },
    });

    if (
      domainRecord === null ||
      domainRecord.website === null ||
      domainRecord.status !== DomainStatus.ACTIVE ||
      domainRecord.website.status !== WebsiteStatus.ACTIVE
    ) {
      throw new NotFoundException("Video not found.");
    }

    const tokenPepper = this.configService
      .get<string>("SHARE_TOKEN_PEPPER")
      ?.trim();

    if (!tokenPepper) {
      this.logger.error(
        "SHARE_TOKEN_PEPPER is missing for public local video.",
      );
      throw new NotFoundException("Video not found.");
    }

    const tokenHash = hashShareToken({
      pepper: tokenPepper,
      token: params.trimmedToken,
    });

    const localVideoInclude = {
      shareLinkVideos: {
        where: {
          videoId: params.videoId,
          video: {
            websiteVideos: {
              some: {
                websiteId: domainRecord.website.id,
                status: AssignmentStatus.ACTIVE,
              },
            },
          },
        },
        take: 1,
        include: {
          video: {
            include: {
              localFileAsset: {
                select: {
                  storageKey: true,
                  mimeType: true,
                  sizeBytes: true,
                },
              },
              localThumbnailAsset: {
                select: {
                  storageKey: true,
                  mimeType: true,
                  sizeBytes: true,
                },
              },
            },
          },
        },
      },
    };

    /* THE ONE PROVIDER-INDEPENDENT CHAIN, so the resume media token is
       understood by LOCAL_FILE playback, the LOCAL_FILE thumbnail and the
       Bunny poster proxy from a single place — exactly as every other
       authorization rule here is. */
    const credentialKind = this.resolveMediaCredentialKind(
      params.trimmedToken,
      params.normalizedHost,
      params.videoId,
    );
    if (credentialKind === null) {
      throw new NotFoundException("Video not found.");
    }

    const shareLink =
      credentialKind.kind === "resume"
        ? await this.prisma.shareLink.findFirst({
            where: {
              id: credentialKind.shareLinkId,
              websiteId: domainRecord.website.id,
            },
            include: localVideoInclude,
          })
        : ((await this.prisma.shareLink.findFirst({
            where: {
              alias: params.trimmedToken,
              websiteId: domainRecord.website.id,
            },
            include: localVideoInclude,
          })) ??
          (await this.prisma.shareLink.findFirst({
            where: {
              tokenHash,
              websiteId: domainRecord.website.id,
            },
            include: localVideoInclude,
          })));

    if (
      shareLink === null ||
      this.getDeniedReasonForMediaPlayback(shareLink, new Date()) !== null
    ) {
      throw new NotFoundException("Video not found.");
    }

    const video = shareLink.shareLinkVideos[0]?.video;

    if (video === undefined || video.status !== VideoStatus.READY) {
      throw new NotFoundException("Video not found.");
    }

    return { shareLink, video };
  }

  /**
   * The LOCAL_FILE narrowing of the shared chain, byte-compatible with what the
   * `local-file` and `thumbnail` routes enforced before the chain was
   * extracted: the same source-type assertion and the same playable-asset
   * predicate, in the same order.
   */
  private async loadAuthorizedPublicLocalVideo(params: {
    normalizedHost: string;
    trimmedToken: string;
    videoId: string;
  }): Promise<{ shareLink: ShareLink; video: PublicWatchVideoWithBinary }> {
    const { shareLink, video } =
      await this.loadAuthorizedPublicMediaVideo(params);

    if (
      video.sourceType !== VideoSourceType.LOCAL_FILE ||
      !this.isPlayableLocalAsset(video.localFileAsset ?? null)
    ) {
      throw new NotFoundException("Video not found.");
    }

    return { shareLink, video };
  }

  private async getAuthorizedPublicVideoForView(params: {
    host: string;
    token: string;
    videoId: string;
  }): Promise<{
    website: Website;
    shareLink: ShareLink;
    video: PublicWatchVideoWithBinary;
  } | null> {
    const normalizedHost = normalizePublicHost(params.host);
    const trimmedToken = this.normalizePublicToken(params.token);

    if (
      normalizedHost === null ||
      trimmedToken === null ||
      !this.isValidPublicVideoId(params.videoId)
    ) {
      return null;
    }

    const domainRecord = await this.prisma.websiteDomain.findUnique({
      where: { domain: normalizedHost },
      include: { website: true },
    });

    if (
      domainRecord === null ||
      domainRecord.website === null ||
      domainRecord.status !== DomainStatus.ACTIVE ||
      domainRecord.website.status !== WebsiteStatus.ACTIVE
    ) {
      return null;
    }

    const tokenPepper = this.configService
      .get<string>("SHARE_TOKEN_PEPPER")
      ?.trim();

    if (!tokenPepper) {
      this.logger.error(
        "SHARE_TOKEN_PEPPER is missing for public video view tracking.",
      );
      return null;
    }

    const tokenHash = hashShareToken({
      pepper: tokenPepper,
      token: trimmedToken,
    });

    const publicViewInclude = {
      shareLinkVideos: {
        where: {
          videoId: params.videoId,
          video: {
            websiteVideos: {
              some: {
                websiteId: domainRecord.website.id,
                status: AssignmentStatus.ACTIVE,
              },
            },
          },
        },
        take: 1,
        include: {
          video: {
            include: {
              binaryAsset: {
                select: {
                  mimeType: true,
                  sizeBytes: true,
                },
              },
              localFileAsset: {
                select: {
                  storageKey: true,
                  mimeType: true,
                  sizeBytes: true,
                },
              },
              localThumbnailAsset: {
                select: {
                  storageKey: true,
                  mimeType: true,
                  sizeBytes: true,
                },
              },
            },
          },
        },
      },
    };

    const credentialKind = this.resolveMediaCredentialKind(
      trimmedToken,
      normalizedHost,
      params.videoId,
    );
    if (credentialKind === null) {
      return null;
    }

    const shareLink =
      credentialKind.kind === "resume"
        ? await this.prisma.shareLink.findFirst({
            where: {
              id: credentialKind.shareLinkId,
              websiteId: domainRecord.website.id,
            },
            include: publicViewInclude,
          })
        : ((await this.prisma.shareLink.findFirst({
            where: {
              alias: trimmedToken,
              websiteId: domainRecord.website.id,
            },
            include: publicViewInclude,
          })) ??
          (await this.prisma.shareLink.findFirst({
            where: {
              tokenHash,
              websiteId: domainRecord.website.id,
            },
            include: publicViewInclude,
          })));

    if (
      shareLink === null ||
      this.getDeniedReasonForMediaPlayback(shareLink, new Date())
    ) {
      return null;
    }

    const video = shareLink.shareLinkVideos[0]?.video;

    if (video === undefined || !this.isPublicPlayableVideo(video)) {
      return null;
    }

    return {
      website: domainRecord.website,
      shareLink,
      video,
    };
  }

  private isPlayableBinaryAsset(
    binaryAsset: PublicBinaryAssetMetadata | null,
  ): binaryAsset is PublicBinaryAssetMetadata {
    return (
      binaryAsset !== null &&
      binaryAsset.mimeType.startsWith("video/") &&
      binaryAsset.sizeBytes > BigInt(0)
    );
  }

  private isPlayableLocalAsset(
    localAsset: PublicLocalAssetMetadata | null,
  ): localAsset is PublicLocalAssetMetadata {
    return (
      localAsset !== null &&
      localAsset.mimeType.startsWith("video/") &&
      localAsset.sizeBytes > BigInt(0)
    );
  }

  private isPlayableImageAsset(
    localAsset: PublicLocalAssetMetadata | null,
  ): localAsset is PublicLocalAssetMetadata {
    return (
      localAsset !== null &&
      localAsset.mimeType.startsWith("image/") &&
      localAsset.sizeBytes > BigInt(0)
    );
  }

  private toSafePublicMediaUrl(url: string | null): string | null {
    const trimmedUrl = url?.trim();

    if (!trimmedUrl || this.isAdminEndpointUrl(trimmedUrl)) {
      return null;
    }

    return trimmedUrl;
  }

  private isAdminEndpointUrl(url: string): boolean {
    try {
      const parsed = new URL(url, "http://public-media.local");
      const pathSegments = parsed.pathname
        .split("/")
        .map((segment) => segment.toLowerCase())
        .filter(Boolean);

      return pathSegments.includes("admin");
    } catch {
      return url.toLowerCase().split(/[?#]/, 1)[0].split("/").includes("admin");
    }
  }

  private parseRangeHeader(
    rangeHeader: string | undefined,
    totalSize: number,
  ): {
    statusCode: 200 | 206;
    start: number;
    end: number;
    length: number;
  } | null {
    if (rangeHeader === undefined || rangeHeader.trim() === "") {
      return {
        statusCode: 200,
        start: 0,
        end: totalSize - 1,
        length: totalSize,
      };
    }

    const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());

    if (rangeMatch === null) {
      return null;
    }

    const [, rawStart, rawEnd] = rangeMatch;

    if (rawStart === "" && rawEnd === "") {
      return null;
    }

    let start: number;
    let end: number;

    if (rawStart === "") {
      const suffixLength = Number(rawEnd);

      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        return null;
      }

      start = Math.max(totalSize - suffixLength, 0);
      end = totalSize - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === "" ? totalSize - 1 : Number(rawEnd);
    }

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= totalSize
    ) {
      return null;
    }

    const boundedEnd = Math.min(end, totalSize - 1);

    return {
      statusCode: 206,
      start,
      end: boundedEnd,
      length: boundedEnd - start + 1,
    };
  }

  private async readDatabaseVideoBinaryChunk(
    videoId: string,
    start: number,
    length: number,
  ): Promise<Buffer> {
    const rows = await this.prisma.$queryRaw<Array<{ data: Buffer }>>(
      Prisma.sql`SELECT SUBSTRING(\`data\`, ${start + 1}, ${length}) AS \`data\` FROM \`VideoBinaryAsset\` WHERE \`videoId\` = ${videoId} LIMIT 1`,
    );
    const data = rows[0]?.data;

    if (data === undefined) {
      throw new NotFoundException("Video not found.");
    }

    return Buffer.from(data);
  }

  private buildPublicBinaryPlaybackUrl(params: {
    token: string;
    videoId: string;
    host: string;
    grant?: string | undefined;
  }): string {
    const rawPrefix = this.configService.get<string>("API_PREFIX") ?? "api/v1";
    const prefix = rawPrefix.replace(/^\/+|\/+$/g, "") || "api/v1";
    const query = this.buildPublicMediaQuery(params.host, params.grant);

    return `/${prefix}/public/watch/${encodeURIComponent(
      params.token,
    )}/videos/${encodeURIComponent(params.videoId)}/binary?${query.toString()}`;
  }

  private buildPublicLocalPlaybackUrl(params: {
    token: string;
    videoId: string;
    host: string;
    grant?: string | undefined;
  }): string {
    const rawPrefix = this.configService.get<string>("API_PREFIX") ?? "api/v1";
    const prefix = rawPrefix.replace(/^\/+|\/+$/g, "") || "api/v1";
    const query = this.buildPublicMediaQuery(params.host, params.grant);

    return `/${prefix}/public/watch/${encodeURIComponent(
      params.token,
    )}/videos/${encodeURIComponent(params.videoId)}/local-file?${query.toString()}`;
  }

  /**
   * The stored poster URL a NON-proxied record may still expose.
   *
   * Fails closed for a record that structurally claims to be a Bunny EMBED but
   * is not addressable through the proxy: emitting its stored pull-zone URL
   * would put back exactly the raw CDN link the proxy exists to remove, and for
   * a `bunny-malformed` record it would hand out an unvalidated provider URL.
   *
   * A Bunny-provider video carrying an OPERATOR-SET poster on some other host
   * is a different case and keeps its existing pass-through behaviour: sync
   * only fills an empty `thumbnailUrl` and never overwrites one, so that value
   * was a deliberate choice and nulling it would silently delete a working
   * image. Everything else — DIRECT_URL, Cloudinary, generic EMBED — is
   * untouched.
   */
  private toSafePublicBunnyAwareUrl(
    video: PublicWatchVideoWithBinary,
  ): string | null {
    // PROXY OFF IS THE DEFAULT, AND IT CHANGES NOTHING. A deployment that has
    // not opted into backend-mediated posters keeps the exact serialization it
    // had before this branch existed — the stored URL, filtered only by
    // `toSafePublicMediaUrl()` — for every source type including Bunny.
    if (this.bunnyThumbnailProxyService?.isEnabled() !== true) {
      return this.toSafePublicMediaUrl(video.thumbnailUrl);
    }

    const classification = classifyBunnyVideoAsset(video);
    if (classification.kind === "not-bunny") {
      return this.toSafePublicMediaUrl(video.thumbnailUrl);
    }

    if (classification.kind === "bunny-malformed") {
      return null;
    }

    const pullZoneHostname =
      this.bunnyStreamService?.getPullZoneHostname() ?? null;

    return isBunnyPullZoneUrl(video.thumbnailUrl, pullZoneHostname)
      ? null
      : this.toSafePublicMediaUrl(video.thumbnailUrl);
  }

  private buildPublicThumbnailUrl(params: {
    token: string;
    videoId: string;
    host: string;
    grant?: string | undefined;
  }): string {
    const rawPrefix = this.configService.get<string>("API_PREFIX") ?? "api/v1";
    const prefix = rawPrefix.replace(/^\/+|\/+$/g, "") || "api/v1";
    const query = this.buildPublicMediaQuery(params.host, params.grant);

    return `/${prefix}/public/watch/${encodeURIComponent(
      params.token,
    )}/videos/${encodeURIComponent(params.videoId)}/thumbnail?${query.toString()}`;
  }

  private toPublicWebsiteResponse(
    website: Pick<Website, "id" | "name" | "slug">,
    domain: string | null,
  ): PublicWatchWebsiteResponse {
    return {
      id: website.id,
      name: website.name,
      slug: website.slug,
      domain,
    };
  }

  private invalidResponse(
    _reasonCode: PublicWatchReasonCode,
    _website?: Pick<Website, "id" | "name" | "slug">,
    _domain: string | null = null,
  ): PublicWatchResponse {
    return {
      valid: false,
      reasonCode: "INVALID_LINK",
      website: null,
      videos: [],
      // NO `resumeGrant` KEY AT ALL. The denial body has been these four
      // properties since this API shipped; a fifth would change a contract
      // deployed clients were written against, and it would buy nothing —
      // `valid: false` already announces the outcome, so the shape reveals
      // nothing the content does not.
    };
  }

  private hasValidMediaGrant(
    shareLink: ShareLink,
    params: { videoId: string; grant?: string | undefined },
    normalizedHost: string,
  ): boolean {
    if (shareLink.maxViews === null) {
      return true;
    }

    return this.publicMediaGrantService.verify(params.grant, {
      shareLinkId: shareLink.id,
      videoId: params.videoId,
      host: normalizedHost,
    });
  }

  private buildPublicMediaQuery(
    host: string,
    grant: string | undefined,
  ): URLSearchParams {
    return new URLSearchParams({
      host,
      ...(grant === undefined ? {} : { grant }),
    });
  }

  private normalizePublicToken(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    /* THE BOUND IS UNCHANGED AT 256, and a resume media token fits inside it
       by design: the reviewer client refuses a media path segment longer than
       that, so anything the API could not fit would be a URL no client would
       fetch. Binding the host into the MAC domain instead of the payload is
       what buys the room. */
    if (value.length > 256) {
      return null;
    }

    const normalized = value.trim();
    return normalized.length === 0 ? null : normalized;
  }

  /**
   * WHICH KIND OF CREDENTIAL IS IN THE `:token` PATH SEGMENT?
   *
   * Media URLs returned by COMPATIBILITY or RESUME carry a short-lived,
   * per-video, host-bound rmv1 token instead of `ShareLink.alias`. This is
   * where media routes distinguish alias-free sessions from historical `#k`.
   *
   * IT IS EXACT, NOT PROBABILISTIC. All legacy share credentials are shorter
   * than the rmv1 minimum length. An alias may begin with `rmv1` and still
   * follows the legacy path; a long rmv1-shaped value is verified or refused,
   * never retried as a share credential.
   *
   * THE KILL SWITCH APPLIES HERE. Compatibility and resume are the email-safe
   * surface, so media derived from either must die with
   * `PUBLIC_COMPATIBILITY_URL_HOSTS` exactly as the resume itself does.
   * Without this, clearing the allowlist during an incident would stop new
   * resumes while every already-issued poster and video URL kept working for
   * the life of its token.
   */
  private resolveMediaCredentialKind(
    trimmedToken: string,
    normalizedHost: string,
    videoId: string,
  ): { kind: "credential" } | { kind: "resume"; shareLinkId: string } | null {
    if (!this.publicReviewResumeService.isMediaToken(trimmedToken)) {
      return { kind: "credential" };
    }

    if (
      !isCompatibilityCapableHost(
        normalizedHost,
        this.configService.get<string>("PUBLIC_COMPATIBILITY_URL_HOSTS"),
      )
    ) {
      return null;
    }

    const claim = this.publicReviewResumeService.verifyMediaToken(
      trimmedToken,
      { host: normalizedHost, videoId },
    );

    return claim === null
      ? null
      : { kind: "resume", shareLinkId: claim.shareLinkId };
  }

  private isValidPublicVideoId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 191;
  }

  private isValidMediaGrantInput(value: unknown): value is string | undefined {
    return (
      value === undefined ||
      (typeof value === "string" && value.length > 0 && value.length <= 2048)
    );
  }

  private invalidVideoViewResponse(): PublicVideoViewResponse {
    return {
      valid: false,
      videoId: null,
      viewCount: null,
      publishedAt: null,
    };
  }

  private async writeAccessLog(params: {
    status: AccessLogStatus;
    reasonCode: PublicWatchReasonCode;
    requestMeta?: PublicWatchRequestMeta | undefined;
    domain?: string | undefined;
    websiteId?: string | undefined;
    shareLinkId?: string | undefined;
  }): Promise<void> {
    try {
      await this.prisma.accessLog.create({
        data: {
          status: params.status,
          reasonCode: truncateReasonCode(params.reasonCode),
          ...(params.websiteId ? { websiteId: params.websiteId } : {}),
          ...(params.shareLinkId ? { shareLinkId: params.shareLinkId } : {}),
          ...(params.domain ? { domain: truncateDomain(params.domain) } : {}),
          ...(this.getIpHash(params.requestMeta)
            ? { ipHash: this.getIpHash(params.requestMeta) }
            : {}),
          ...(truncateAccessLogValue(params.requestMeta?.userAgent, 1024)
            ? {
                userAgent: truncateAccessLogValue(
                  params.requestMeta?.userAgent,
                  1024,
                ),
              }
            : {}),
          // QUERY AND FRAGMENT STRIPPED. A referer can carry a share
          // credential — `/watch?r=<transportAlias>` and the V1
          // `/?token=<rawToken>` both do — and this row outlives the link.
          // See `sanitizeAccessLogReferer()`.
          ...(sanitizeAccessLogReferer(params.requestMeta?.referer)
            ? {
                referer: sanitizeAccessLogReferer(params.requestMeta?.referer),
              }
            : {}),
        },
      });
    } catch (error) {
      this.logger.warn(
        {
          reasonCode: params.reasonCode,
          status: params.status,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Public access log write failed.",
      );
    }
  }

  private getIpHash(meta: PublicWatchRequestMeta | undefined): string | null {
    return hashIpAddress({
      ip: meta?.ip,
      pepper: this.configService.get<string>("ACCESS_LOG_IP_PEPPER"),
    });
  }
}
