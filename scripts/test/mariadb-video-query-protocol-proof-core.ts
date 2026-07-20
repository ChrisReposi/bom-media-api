import { randomBytes } from "node:crypto";
import { assertDestructiveTestDatabase } from "../safety/assert-destructive-test-database";

export const MARIADB_VIDEO_QUERY_PROOF_DATABASE =
  "video_share_cms_mariadb_test";
export const MARIADB_VIDEO_QUERY_FIXTURE_COUNT = 236;

export type MariaDbProofIdentity = {
  runId: string;
  websiteId: string;
  websiteSlug: string;
  adminId: string;
  adminUsername: string;
  videoIdPrefix: string;
  videoSlugPrefix: string;
};

export function assertMariaDbVideoQueryProofDatabase(
  env: NodeJS.ProcessEnv = process.env,
): { host: string; database: string } {
  const target = assertDestructiveTestDatabase(env);
  if (target.database !== MARIADB_VIDEO_QUERY_PROOF_DATABASE) {
    throw new Error(
      `MariaDB query proof requires database ${MARIADB_VIDEO_QUERY_PROOF_DATABASE}`,
    );
  }
  return target;
}

export function buildMariaDbProofIdentity(
  now = Date.now(),
  entropy = randomBytes(4).toString("hex"),
): MariaDbProofIdentity {
  const runId = `mariadbq_${now}_${entropy}`;
  if (!/^mariadbq_[0-9]+_[a-f0-9]{8}$/.test(runId)) {
    throw new Error("MariaDB query proof run identifier is invalid.");
  }
  return {
    runId,
    websiteId: `${runId}_website`,
    websiteSlug: `${runId}-website`,
    adminId: `${runId}_admin`,
    adminUsername: `${runId.slice(0, 28)}`,
    videoIdPrefix: `${runId}_video_`,
    videoSlugPrefix: `${runId}-sml-video-`,
  };
}

export function protocolLabel(useTextProtocol: boolean): "binary" | "text" {
  return useTextProtocol ? "text" : "binary";
}
