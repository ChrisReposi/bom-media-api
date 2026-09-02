import { randomBytes } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { normalizeWebsiteDomain } from "../../common/utils/domain.util";

export function generateShareToken(): string {
  return `s_${randomBytes(32).toString("base64url")}`;
}

/**
 * Bytes of CSPRNG material behind a new alias. 12 bytes encode to exactly 16
 * unpadded base64url characters, which is the full width of
 * `ShareLink.alias VARCHAR(16)` — so this is the strongest alias the existing
 * column can hold, and it needs no migration.
 */
const SHARE_ALIAS_RANDOM_BYTES = 12;

/**
 * The alias is a BEARER CREDENTIAL, not a short display code.
 * `PublicService.resolvePublicWatch()` accepts it in place of a raw share
 * token, so on the bound host the alias alone authorizes the watch — and a
 * canonical alias never expires, because a canonical link is permanent by
 * construction.
 *
 * It was previously `randomBytes(5)`: 7 base64url characters, **40 bits**.
 * That is far below what a long-lived bearer credential should carry, and the
 * canonical work made it materially worse by giving those aliases unlimited
 * lifetime. 12 bytes raises a NEW alias to **96 bits** at 16 characters.
 *
 * EXISTING ALIASES ARE NEVER TOUCHED. They remain valid forever — rotating one
 * would break every reviewer URL already handed out, which is the exact
 * regression the compatibility contract forbids. Length is not part of the
 * lookup: the public resolver matches `alias` by equality with no length or
 * charset assumption anywhere, so 7- and 16-character aliases coexist.
 *
 * base64url is deliberate: `[A-Za-z0-9_-]` survives a URL fragment untouched,
 * so `encodeURIComponent()` is a no-op and the emitted URL is byte-stable.
 */
export function generateShareAlias(): string {
  return randomBytes(SHARE_ALIAS_RANDOM_BYTES).toString("base64url");
}

/**
 * Bytes of CSPRNG material behind an EMAIL-SAFE TRANSPORT ALIAS. 16 bytes
 * encode to exactly 22 unpadded base64url characters: 128 bits.
 */
const TRANSPORT_ALIAS_RANDOM_BYTES = 16;

/** The one shape a transport alias can ever have: exactly 22 base64url chars. */
export const TRANSPORT_ALIAS_LENGTH = 22;
const TRANSPORT_ALIAS_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * THE TRANSPORT ALIAS IS AN ALTERNATE BEARER CREDENTIAL.
 *
 * Say this precisely, because the imprecise version is dangerous. Possession
 * of a transport alias, presented to
 * `POST /public/watch/exchange-compatible` on the bound host, yields access
 * to the same ShareLink that `#k` yields. It is therefore a SECRET of the
 * same class as `alias`, and every rule that protects `alias` — never
 * logged, never audited, never in an error, never in an AccessLog row —
 * applies to it unchanged.
 *
 * What it is NOT is a SECOND AUTHORIZATION MODEL. It confers no permission
 * of its own: `resolvePublicWatchCompatible()` maps it to a row and re-enters
 * the unmodified V2 resolver by that row's own `alias`, so status, expiry,
 * `maxViews`, membership, assignment and host binding are decided in exactly
 * one place for both credentials.
 *
 * Its properties, each deliberate:
 *
 * - SEPARATE from `alias`, and the separation is the point. `alias` travels
 *   in a URI fragment, which a browser never transmits; a transport alias
 *   travels in a query string, which a static host, every proxy and every
 *   CDN on the way DO see. Compromise of a transport alias therefore grants
 *   access to that ShareLink until the link is revoked or otherwise becomes
 *   invalid — and reveals NOTHING about the `#k` alias, because the two
 *   values share no bytes and neither is derived from the other.
 * - 128 bits from the CSPRNG, because it is exposed in a place the fragment
 *   credential never reaches and must not be guessable.
 * - ONE shape. `alias` is 7 or 16 characters and a raw token is `s_` + 43,
 *   so no value of one kind can validate as another: the compatibility
 *   endpoint cannot be handed a `#k` credential, and the V2 resolver cannot
 *   be handed a transport alias.
 *
 * Stored in clear, like `alias`, because the URL must be re-displayable: a
 * canonical link is re-issued on every request. See ADR 0003 and
 * docs/superpowers/specs/2026-09-02-email-safe-reviewer-url-design.md.
 */
export function generateTransportAlias(): string {
  return randomBytes(TRANSPORT_ALIAS_RANDOM_BYTES).toString("base64url");
}

/**
 * Exactly the minted shape, and nothing else. No trimming, no decoding, no
 * case folding: a value that needed any of those was not issued by this
 * backend, and normalising it would hand the lookup different bytes from
 * the ones in the URL.
 */
export function isWellFormedTransportAlias(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === TRANSPORT_ALIAS_LENGTH &&
    TRANSPORT_ALIAS_PATTERN.test(value)
  );
}

/**
 * REVIEWER-CLIENT CAPABILITY: which hosts can redeem `/watch?r=<transportAlias>`.
 *
 * THIS BACKEND SERVES MORE THAN ONE REVIEWER FRONTEND, and they are not
 * interchangeable. Every one of them redeems the fragment form `#k=`; only a
 * frontend that has shipped the compatibility bootstrap can redeem the query
 * form. Measured on 2026-09-02:
 *
 *   CPR_arcwildstudios   `src/js/watch.js` parses `?r=` and scrubs it   YES
 *   public_website       `assets/app.js` reads only `token`/`t` from the
 *                        query; `/watch?r=…` yields no credential and the
 *                        route falls through to the reviewer room's
 *                        "link is incomplete" state                    NO
 *   Worldfold_Studio     `private-watch-access.js` matches `#k=` and
 *                        `#/s/` only; `/watch?r=…` is INERT            NO
 *
 * So emitting a compatibility URL for an unsupported host would hand a
 * reviewer a link that loads a real page and then does nothing — a silent
 * broken URL, which is worse than the fragment-stripping problem the feature
 * exists to solve. The allowlist is therefore a REQUIRED, EXPLICIT
 * deployment declaration and it FAILS CLOSED: unset means no host gets a
 * compatibility URL, anywhere.
 *
 * It is an allowlist of hosts rather than a database column because the
 * capability belongs to the deployed FRONTEND BUNDLE, not to the website
 * record: the same `Website` row serves whatever bundle its operator
 * uploaded, and the fact being declared is "the bundle at this hostname
 * understands `?r=`". Config also means enabling a customer is a one-line
 * deploy change with no migration and no data to backfill. The shape matches
 * `VIDEO_EMBED_ALLOWED_HOSTS`, the codebase's existing comma-separated host
 * allowlist.
 *
 * Entries are normalized with the SAME `normalizeWebsiteDomain()` the domain
 * table and public host resolution use, so a comparison here cannot disagree
 * with the host that was actually matched.
 */
export function parseCompatibilityUrlHosts(raw: string | undefined): string[] {
  if (typeof raw !== "string") {
    return [];
  }

  const hosts = new Set<string>();
  for (const entry of raw.split(",")) {
    const normalized = normalizeWebsiteDomain(entry);
    if (normalized !== null) {
      hosts.add(normalized);
    }
  }

  return [...hosts];
}

/**
 * Whether the reviewer frontend at this host can redeem a compatibility URL.
 *
 * ONE PREDICATE, ONE CALLER-FACING ANSWER. No service guesses at a hostname:
 * the value passed in is the SAME host string the URL is being built from —
 * the canonical snapshot host for a canonical link, the preferred active
 * domain for a bundle — so a URL is emitted only when the exact host it names
 * was declared.
 */
export function isCompatibilityUrlHost(
  host: string | null | undefined,
  allowedHosts: readonly string[],
): boolean {
  if (allowedHosts.length === 0 || typeof host !== "string") {
    return false;
  }

  const normalized = normalizeWebsiteDomain(host);

  return normalized !== null && allowedHosts.includes(normalized);
}

/**
 * IS THE REVIEWER FRONTEND AT THIS HOST COMPATIBILITY-CAPABLE?
 *
 * The whole rule in one function: parse the raw allowlist, normalize both
 * sides through `normalizeWebsiteDomain()`, compare for exact equality.
 *
 * TWO CALLERS, BOTH OF WHICH MUST AGREE, WHICH IS WHY THIS EXISTS:
 *
 *   EMISSION   `AdminWebsitesService.supportsCompatibilityUrl()` — may the
 *              Admin be handed a `/watch?r=` URL for this host at all?
 *   REDEMPTION `PublicService.resolvePublicWatchCompatible()` — may a
 *              transport alias presented on this host be redeemed?
 *
 * They must give the same answer for the same host or the allowlist stops
 * being a kill switch and becomes a suggestion. Composing the parse and the
 * match here means a caller cannot get the composition wrong — the only thing
 * either one supplies is the raw environment string and a host.
 */
export function isCompatibilityCapableHost(
  host: string | null | undefined,
  rawAllowedHosts: string | undefined,
): boolean {
  return isCompatibilityUrlHost(
    host,
    parseCompatibilityUrlHosts(rawAllowedHosts),
  );
}

/**
 * THE ONLY GENERATOR OF AN EMAIL-SAFE REVIEWER URL, AND IT IS CANONICAL-ONLY.
 *
 *   https://<snapshotHost>/watch?r=<transportAlias>
 *
 * There is deliberately NO bundle-shaped counterpart. A bundle link may carry
 * `expiresAt` and `maxViews`, and the compatibility exchange consumes a view
 * exactly as the V2 exchange does — so a JavaScript-executing mail security
 * scanner could spend a limited bundle's budget before the reviewer ever
 * opened it. A canonical link cannot be budgeted or expired by construction
 * (`createOrGetCanonical()` pins `expiresAt: null, maxViews: null` and
 * `assertCanonicalOptionsAbsent()` refuses a request that asks for either),
 * so the same scanner spends nothing that matters.
 *
 * A generator taking an arbitrary domain therefore does not exist, rather
 * than existing and going uncalled: widening this to bundles has to be a
 * deliberate act of writing one, not of adding a call.
 *
 * Host and protocol come from the canonical SNAPSHOT, exactly as
 * `buildCanonicalReviewUrl()` takes them, so the two URLs for one pair never
 * disagree about origin and this one is byte-identical for the pair forever.
 *
 * It places the TRANSPORT ALIAS in the query — never `alias`, never a token.
 */
export function buildCanonicalCompatibilityUrl(params: {
  host: string;
  transportAlias: string;
  protocol: string;
}): string {
  const host = normalizeWebsiteDomain(params.host.trim());
  if (host === null) {
    throw new BadRequestException("Canonical share host is invalid.");
  }

  if (!isWellFormedTransportAlias(params.transportAlias)) {
    throw new BadRequestException("Compatibility share alias is invalid.");
  }

  const protocol = resolvePublicSiteProtocol(host, params.protocol);

  return `${protocol}://${host}/watch?r=${params.transportAlias}`;
}

/**
 * The clean (V2) public share URL.
 *
 *   https://<domain>/watch#k=<credential>
 *
 * WHY THE CREDENTIAL STAYS IN THE FRAGMENT.
 * `<credential>` is a bearer secret: `PublicService.resolvePublicWatch()`
 * accepts it as either a ShareLink `alias` or a raw share token and, once the
 * host matches, that alone authorizes the watch. A path segment or a query
 * parameter is transmitted to the static host and to every proxy in front of
 * it, so it is written into access logs that a share credential must never
 * reach. A URI fragment is never sent to any server.
 *
 * So V2 changes the PATH and not the credential's location. `/watch/<alias>`
 * was considered and rejected for exactly this reason. The previous forms
 * remain valid inbound links forever - the public site still parses every one
 * of them - this only changes what newly created links look like.
 */
function buildCleanPublicShareUrl(params: {
  protocol: string;
  domain: string;
  credential: string;
}): string {
  return `${params.protocol}://${params.domain}/watch#k=${encodeURIComponent(
    params.credential,
  )}`;
}

export function buildPublicShareUrl(params: {
  domain: string;
  alias?: string | undefined;
  token?: string | undefined;
  protocol?: string | undefined;
}): string {
  const domain = params.domain.trim();

  if (!domain) {
    throw new BadRequestException("Public share domain is required.");
  }

  const normalizedDomain = normalizeWebsiteDomain(domain);

  if (normalizedDomain === null) {
    throw new BadRequestException("Public share domain is invalid.");
  }

  const protocol = resolvePublicSiteProtocol(normalizedDomain, params.protocol);
  const alias = params.alias?.trim();

  if (alias) {
    return buildCleanPublicShareUrl({
      protocol,
      domain: normalizedDomain,
      credential: alias,
    });
  }

  const token = params.token?.trim();

  if (!token) {
    throw new BadRequestException("Public share token or alias is required.");
  }

  // The no-alias branch is not reachable from the current create path, which
  // always supplies a freshly generated alias. It previously emitted
  // `/?token=<token>#/videos`, putting a raw 256-bit share token into a query
  // string and therefore into every access log on the way. It now uses the
  // same fragment-only form as the alias branch.
  return buildCleanPublicShareUrl({
    protocol,
    domain: normalizedDomain,
    credential: token,
  });
}

/**
 * Canonical display URL for DMCA/provenance records. Uses the hash-router
 * form (`/#/s/<alias>/videos`) because the public sites are static SPAs where
 * the path form needs a server rewrite; this is also the exact shape the
 * Admin normalizer produces, so the recorded URL is byte-for-byte stable
 * regardless of which client rebuilds it. Host and protocol must come from
 * the canonical snapshot, never from the currently-preferred domain.
 *
 * DELIBERATELY NOT MIGRATED TO THE CLEAN (V2) FORM. This URL is provenance
 * evidence: the same website+video pair must keep producing a byte-identical
 * string forever, because copies of it have already been recorded in
 * DMCA/takedown submissions. Changing the shape would make previously filed
 * evidence disagree with what the system now reports for the same record. The
 * public site parses this form and the clean form identically, so a reviewer
 * following either one reaches the same ShareLink; only the recorded text is
 * pinned. Presentation of NEW links is `buildPublicShareUrl()`'s job.
 */
export function buildCanonicalPublicShareUrl(params: {
  host: string;
  alias: string;
  protocol: string;
}): string {
  const host = normalizeWebsiteDomain(params.host.trim());
  if (host === null) {
    throw new BadRequestException("Canonical share host is invalid.");
  }

  const alias = params.alias.trim();
  if (!alias) {
    throw new BadRequestException("Canonical share alias is required.");
  }

  const protocol = resolvePublicSiteProtocol(host, params.protocol);
  return `${protocol}://${host}/#/s/${encodeURIComponent(alias)}/videos`;
}

/**
 * The V2 REVIEWER URL for a canonical link.
 *
 * Same website+video pair → same `alias` → byte-identical string, forever.
 * Host and protocol come from the canonical SNAPSHOT, exactly as
 * `buildCanonicalPublicShareUrl()` does, so this never follows a later change
 * of preferred domain either.
 *
 * WHY THIS EXISTS ALONGSIDE `buildCanonicalPublicShareUrl()`.
 * Those two answer different questions about the same ShareLink:
 *
 * - `buildCanonicalPublicShareUrl()` is the PROVENANCE record. Its hash-router
 *   shape is pinned because copies of that exact string already sit in filed
 *   DMCA submissions; re-shaping it would make filed evidence disagree with
 *   what the system reports. It must never change.
 * - this is what an OPERATOR copies and a REVIEWER opens. New links are V2
 *   everywhere else in the product, and a canonical link is the one an operator
 *   hands out most often, so emitting the V1 shape here would be the visible
 *   regression.
 *
 * Both carry the same credential and resolve to the same ShareLink — the
 * public site parses either form identically. Only the recorded text is pinned,
 * not the presented one.
 */
export function buildCanonicalReviewUrl(params: {
  host: string;
  alias: string;
  protocol: string;
}): string {
  const host = normalizeWebsiteDomain(params.host.trim());
  if (host === null) {
    throw new BadRequestException("Canonical share host is invalid.");
  }

  const alias = params.alias.trim();
  if (!alias) {
    throw new BadRequestException("Canonical share alias is required.");
  }

  return buildCleanPublicShareUrl({
    protocol: resolvePublicSiteProtocol(host, params.protocol),
    domain: host,
    credential: alias,
  });
}

export function resolvePublicSiteProtocol(
  domain: string,
  configuredProtocol?: string,
): "http" | "https" {
  const normalizedProtocol = configuredProtocol?.trim().toLowerCase();

  if (normalizedProtocol === "http" || normalizedProtocol === "https") {
    return normalizedProtocol;
  }

  if (
    domain.startsWith("localhost") ||
    domain.startsWith("127.0.0.1") ||
    domain.startsWith("0.0.0.0") ||
    domain.includes(":5500")
  ) {
    return "http";
  }

  return "https";
}
