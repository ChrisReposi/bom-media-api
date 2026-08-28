/**
 * THE ONE COPY of the historical-adoption policy.
 *
 * Two callers need it and they must never disagree:
 *
 * - `CanonicalShareLinkService.createOrGetCanonical()`, which decides at
 *   request time which historical ShareLink becomes a pair's permanent
 *   canonical identity;
 * - `scripts/audit/canonical-share-link-audit-core.ts`, which tells an operator
 *   IN ADVANCE what that decision will be.
 *
 * A read-only audit that predicts a different winner than the code will
 * actually pick is worse than no audit: an operator reads it, plans around it,
 * and is then surprised in production. So the rule lives here, is pure, and is
 * unit-testable without Prisma or Nest.
 *
 * ── IDENTITY IS NOT USABILITY. READ THIS BEFORE CHANGING ANYTHING HERE. ──────
 *
 * Selecting the winner and deciding whether the winner currently WORKS are two
 * different questions, and conflating them is a security defect.
 *
 * The winner is the NEWEST created exact single-video link, full stop. Its
 * status is not an input. If that link was REVOKED or DISABLED, the pair's
 * canonical identity is still that link, and the request then fails closed with
 * the existing conflict code.
 *
 * Filtering to "eligible" candidates first looks safer and is the opposite. Two
 * concrete bypasses it creates:
 *
 *   - Pair has L1 (Jan, ACTIVE) and L2 (Apr) which the owner REVOKED after a
 *     leak. Filtering picks L1 and hands back a WORKING url — the owner's
 *     revoke is silently routed around.
 *   - Pair has only L2, revoked. Filtering finds nothing eligible and MINTS a
 *     brand-new working link for a video whose only share link the owner
 *     deliberately took away.
 *
 * Neither is acceptable. A non-`ACTIVE` `ShareLink.status` therefore does NOT
 * disqualify a winner and never causes a fallback or a mint.
 *
 * ── FOUR DISTINCT CONDITIONS. DO NOT CONFLATE THEM. ─────────────────────────
 *
 * "Expired" is ambiguous in this domain and is never used unqualified here.
 * There are two unrelated things it could mean, and they behave differently:
 *
 * | Condition                          | Kind             | Winner selection | Pin? | Outcome |
 * |------------------------------------|------------------|------------------|------|---------|
 * | `status === REVOKED`               | status enum      | not consulted    | YES  | pinned, then `CANONICAL_LINK_REVOKED` |
 * | `status === DISABLED`              | status enum      | not consulted    | YES  | pinned, then `CANONICAL_LINK_INACTIVE` |
 * | `status === EXPIRED`               | status enum      | not consulted    | YES  | pinned, then `CANONICAL_LINK_INACTIVE` |
 * | `expiresAt !== null`               | time-based COLUMN| not consulted    | NO   | refused pre-write, `HAS_EXPIRY` |
 * | `maxViews !== null`                | budget COLUMN    | not consulted    | NO   | refused pre-write, `HAS_MAX_VIEWS` |
 *
 * `status === EXPIRED` and `expiresAt !== null` are INDEPENDENT. Nothing in this
 * repository writes `ShareLinkStatus.EXPIRED` — expiry is enforced from the
 * `expiresAt` column alone (see `features/share-links.md` §8.1) — so a link can
 * carry an `expiresAt` while its status is `ACTIVE`, and could in principle
 * carry the `EXPIRED` status with a null `expiresAt`. They are checked in
 * different places, by different code, for different reasons.
 *
 * A `maxViews` link that has been fully consumed ("exhausted by views") is not a
 * separate case either: `maxViews !== null` blocks the pin regardless of how much
 * of the budget is left, and `currentViews` is never consulted.
 *
 * ── WHAT DOES BLOCK A PIN, AND WHY IT IS A REFUSAL RATHER THAN A FALLBACK ────
 *
 * A small set of conditions make the winner impossible to pin *structurally* —
 * not merely unusable today. For those, the answer is an explicit
 * owner-review/remediation conflict with NOTHING written: no mapping, no
 * replacement link, and emphatically no older candidate promoted in its place.
 * See `assessHistoricalWinnerPinnability()`.
 */
import { ShareLinkStatus } from "../../generated/prisma/client";

/** Recorded on every automatic adoption, in the audit row and the report. */
export const CANONICAL_AUTO_ADOPT_SELECTION_POLICY =
  "LATEST_CREATED_AT" as const;

/** The pair a historical link is already the canonical anchor for, if any. */
export type CanonicalAnchoredPair = {
  websiteId: string;
  videoId: string;
};

/**
 * The columns the historical decision is made from.
 *
 * `currentViews`, `lastViewedAt` and `updatedAt` are DELIBERATELY ABSENT.
 *
 * - `currentViews` — views already served say nothing about identity.
 * - `lastViewedAt` / `updatedAt` — both move for reasons that have nothing to do
 *   with which URL is in circulation, so ordering on either would let an
 *   unrelated write silently change a pair's canonical identity.
 *
 * `status` IS present, but only so the caller can report it and fail closed
 * afterwards. It is **not** a selection input — see the header.
 */
export type CanonicalAdoptionCandidate = {
  id: string;
  alias: string | null;
  status: ShareLinkStatus | string;
  expiresAt: Date | null;
  maxViews: number | null;
  createdAt: Date;
  /** Non-null when this link already anchors some canonical mapping. */
  anchoredPair?: CanonicalAnchoredPair | null | undefined;
};

/**
 * Why the winner cannot be PINNED as a permanent identity.
 *
 * Every value here is a structural or integrity problem, never "it does not
 * work right now". A `REVOKED` link is perfectly pinnable; it simply denies.
 */
export type CanonicalPinBlocker =
  | "ALIAS_MISSING"
  | "HAS_EXPIRY"
  | "HAS_MAX_VIEWS"
  | "ANCHORED_TO_OTHER_PAIR";

export type CanonicalHistoricalSelection = {
  /** The newest exact single-video link, whatever its status. */
  winner: CanonicalAdoptionCandidate | null;
  /** Every exact single-video link found for the pair. */
  historicalCandidateCount: number;
  /** Set when the winner cannot be pinned; the caller must then refuse. */
  pinBlocker: CanonicalPinBlocker | null;
};

/**
 * Newest first, with `id` descending as the tie-break.
 *
 * `createdAt` alone is not enough: MySQL `DATETIME(3)` has millisecond
 * resolution and two links minted in the same millisecond are entirely
 * possible, so without a second key the winner would depend on whatever order
 * the storage engine happened to return. `id` is immutable and unique, which is
 * exactly what a tie-break needs — and it is ONLY a tie-break, never a primary
 * ordering.
 *
 * Sorting happens in JavaScript even though the query already asks the database
 * for the same order. That is deliberate: it makes the winner independent of
 * the column's collation, and it means the audit script and the service compute
 * the answer with the same code rather than merely the same intent.
 */
export function compareCanonicalCandidates(
  a: CanonicalAdoptionCandidate,
  b: CanonicalAdoptionCandidate,
): number {
  const byCreatedAt = b.createdAt.getTime() - a.createdAt.getTime();
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }

  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Whether the winner can be written as the pair's permanent mapping, or the
 * reason it cannot.
 *
 * THE TEST APPLIED HERE IS "CAN THIS BE PINNED AT ALL", NOT "DOES IT WORK".
 * Status is deliberately absent.
 *
 * - `ALIAS_MISSING` — the alias IS the canonical URL's credential;
 *   `buildCanonicalReviewUrl()` refuses to build one without it. Pinning such a
 *   row would commit a mapping whose response construction then throws, on this
 *   request and on every later one, with no HTTP path to undo it — all four
 *   `CanonicalVideoShareLink` relations are `onDelete: Restrict` and nothing
 *   un-adopts a mapping. That is the one genuinely unremediable outcome, so the
 *   mapping is not written and the operator restores the credential first.
 * - `HAS_EXPIRY` / `HAS_MAX_VIEWS` — these are legacy ACCESS CONTROLS that the
 *   canonical contract cannot REPRESENT, so pinning one would make the system
 *   describe itself untruthfully.
 *
 *   To be precise about what is and is not at risk: PUBLIC resolution enforces
 *   both independently and never consults the canonical mapping —
 *   `PublicService.getDeniedReason()` returns `EXPIRED_LINK` /
 *   `VIEW_LIMIT_REACHED`, `incrementShareLinkView()` re-checks both in its
 *   atomic conditional update, and `getDeniedReasonForMediaPlayback()` re-checks
 *   expiry on every media route. **Neither control can be bypassed by pinning.**
 *
 *   What breaks instead is the canonical contract itself: the ADMIN side would
 *   report the pair's "permanent" canonical URL while reviewers were being
 *   denied — and once the link lapses the pair's one identity is dead, with no
 *   replacement possible (rotation is deliberately not implemented). Minting a
 *   replacement instead WOULD bypass the control outright, and promoting an
 *   older link would too. Refusing is the only option that does neither. The
 *   pair waits for an owner.
 *
 *   `assertReusable()` now refuses the same two columns on an ALREADY-EXISTING
 *   mapping (`CANONICAL_LINK_OPTIONS_PRESENT`), which is a different guard for a
 *   different population: this one stops such a link being PINNED, that one
 *   stops a mapping pinned before the check existed from being handed back as a
 *   URL. Neither subsumes the other.
 * - `ANCHORED_TO_OTHER_PAIR` — `CanonicalVideoShareLink.shareLinkId` is unique,
 *   so one link cannot anchor two pairs. Finding the newest historical link for
 *   THIS pair already anchoring a DIFFERENT one is a data-integrity fault, not a
 *   routine skip. Passing over it and blessing an older candidate would hide
 *   the fault and hand out an identity the operator never chose.
 *
 * In every case the caller writes NOTHING: no mapping, no replacement link, and
 * no fallback to an older candidate.
 */
export function assessHistoricalWinnerPinnability(
  winner: CanonicalAdoptionCandidate,
  pair: CanonicalAnchoredPair,
): CanonicalPinBlocker | null {
  if (winner.alias === null || winner.alias.trim() === "") {
    return "ALIAS_MISSING";
  }
  if (winner.expiresAt !== null) {
    return "HAS_EXPIRY";
  }
  if (winner.maxViews !== null) {
    return "HAS_MAX_VIEWS";
  }

  const anchored = winner.anchoredPair ?? null;
  if (
    anchored !== null &&
    (anchored.websiteId !== pair.websiteId || anchored.videoId !== pair.videoId)
  ) {
    return "ANCHORED_TO_OTHER_PAIR";
  }

  return null;
}

/**
 * The pair's historical winner, and whether it can be pinned.
 *
 * `winner === null` — and ONLY that — permits the caller to mint a fresh
 * canonical link. A pair that has historical links always resolves to one of
 * them or to a refusal; it never mints, because minting would manufacture a
 * working credential for a pair whose existing credential may have been
 * deliberately revoked, expired or budgeted.
 *
 * Nothing here rewrites, revokes or repairs any legacy row. Selection chooses
 * which existing row becomes canonical; it has no mandate over the others, which
 * may already be cited in DMCA evidence or bookmarked by a reviewer.
 */
export function selectCanonicalHistoricalWinner(
  candidates: CanonicalAdoptionCandidate[],
  pair: CanonicalAnchoredPair,
): CanonicalHistoricalSelection {
  if (candidates.length === 0) {
    return { winner: null, historicalCandidateCount: 0, pinBlocker: null };
  }

  const ordered = [...candidates].sort(compareCanonicalCandidates);
  const winner = ordered[0];

  return {
    winner,
    historicalCandidateCount: candidates.length,
    pinBlocker: assessHistoricalWinnerPinnability(winner, pair),
  };
}

/**
 * Whether a status means the pinned identity currently denies access.
 *
 * Reporting only — the service fails closed through the existing
 * `assertReusable()` codes. Exposed so the read-only audit can tell an operator
 * "this pair will pin, and then deny" in advance instead of surprising them.
 */
export function isDenyingShareLinkStatus(
  status: ShareLinkStatus | string,
): boolean {
  return status !== ShareLinkStatus.ACTIVE;
}
