import { randomBytes } from "node:crypto";
import { assertDestructiveTestDatabase } from "../safety/assert-destructive-test-database";

export const MARIADB_COLLATION_PROOF_DATABASE =
  "video_share_cms_collation_test";

/**
 * The collation the migrations declare for every table/column
 * (`DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`). This is the
 * schema contract the proof asserts against - never the host default, which on
 * stock MariaDB 11.8 is utf8mb4_uca1400_ai_ci.
 */
export const SCHEMA_COLLATION = "utf8mb4_unicode_ci";
export const SCHEMA_CHARSET = "utf8mb4";

export type CollationProofIdentity = {
  runId: string;
  videoIdPrefix: string;
  videoSlugPrefix: string;
};

export function assertMariaDbCollationProofDatabase(
  env: NodeJS.ProcessEnv = process.env,
): { host: string; database: string } {
  const target = assertDestructiveTestDatabase(env);
  if (target.database !== MARIADB_COLLATION_PROOF_DATABASE) {
    throw new Error(
      `MariaDB collation proof requires database ${MARIADB_COLLATION_PROOF_DATABASE}`,
    );
  }
  return target;
}

export function buildCollationProofIdentity(
  now = Date.now(),
  entropy = randomBytes(4).toString("hex"),
): CollationProofIdentity {
  const runId = `collq_${now}_${entropy}`;
  if (!/^collq_[0-9]+_[a-f0-9]{8}$/.test(runId)) {
    throw new Error("Collation proof run identifier is invalid.");
  }
  return {
    runId,
    videoIdPrefix: `${runId}_video_`,
    videoSlugPrefix: `${runId}-video-`,
  };
}

/**
 * Search cases pinned by the incident. Each entry is
 * [case id, raw search input, expected matching fixture titles].
 */
export const SEARCH_CASES: ReadonlyArray<
  readonly [string, string, readonly string[]]
> = [
  ["SEARCH-02", "Surprised", ["Surprised cat"]],
  ["SEARCH-09", "100%", ["100% real deal"]],
  ["SEARCH-10", "a_b", ["a_b underscore"]],
  ["SEARCH-11", "back\\slash", ["back\\slash title"]],
  ["SEARCH-12", "Bất ngờ", ["Bất ngờ quá"]],
  ["SEARCH-15", "zzz-no-such-video", []],
];
