export const GATE3C1_DATABASE = "video_share_cms_test";

const RUN_ID_PATTERN = /^gate3c1_\d{13}_[0-9a-f]{6}$/;

export type Gate3c1FixtureIdentity = {
  runId: string;
  adminId: string;
  websiteId: string;
  legacyWebsiteId: string;
  domainId: string;
  legacyDomainId: string;
  legacyVideoId: string;
  legacyBinaryId: string;
  legacyAssignmentId: string;
};

export type Gate3c1CleanupScope = {
  adminId: string;
  websiteIds: readonly [string, string];
  domainIds: readonly [string, string];
  legacyVideoId: string;
};

export function assertGate3c1Database(database: string): void {
  if (database !== GATE3C1_DATABASE) {
    throw new Error(
      `Gate 3C-1 requires exactly ${GATE3C1_DATABASE}; received a different database.`,
    );
  }
}

export function assertGate3c1RunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      "Gate 3C-1 requires a run-scoped id shaped gate3c1_<timestamp>_<hex>.",
    );
  }
}

export function buildGate3c1FixtureIdentity(
  runId: string,
): Gate3c1FixtureIdentity {
  assertGate3c1RunId(runId);

  return {
    runId,
    adminId: `${runId}_admin`,
    websiteId: `${runId}_website`,
    legacyWebsiteId: `${runId}_legacy_website`,
    domainId: `${runId}_domain`,
    legacyDomainId: `${runId}_legacy_domain`,
    legacyVideoId: `${runId}_legacy_video`,
    legacyBinaryId: `${runId}_legacy_binary`,
    legacyAssignmentId: `${runId}_legacy_assignment`,
  };
}

export function buildGate3c1CleanupScope(
  identity: Gate3c1FixtureIdentity,
): Gate3c1CleanupScope {
  assertGate3c1RunId(identity.runId);

  const scopedValues = Object.values(identity);
  if (
    scopedValues.some(
      (value) => value !== identity.runId && !value.startsWith(identity.runId),
    )
  ) {
    throw new Error("Cleanup identity contains a value outside the proof run.");
  }

  return {
    adminId: identity.adminId,
    websiteIds: [identity.websiteId, identity.legacyWebsiteId],
    domainIds: [identity.domainId, identity.legacyDomainId],
    legacyVideoId: identity.legacyVideoId,
  };
}

export function safeProofMessage(
  label: string,
  status: "PASS" | "PROVEN",
): string {
  return `${status}: ${label}`;
}
