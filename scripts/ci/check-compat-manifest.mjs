#!/usr/bin/env node
/**
 * MANIFEST CONSISTENCY GATE — not an execution gate.
 *
 * Compares two inventories of Wave A compatibility ids:
 *
 *   source   every COMPAT-nnn named in test/share-link-compat-*.test.ts
 *   manifest every COMPAT-nnn documented in
 *            docs/SHARE_LINK_COMPATIBILITY_TESTS.md
 *
 * It fails when the two disagree, or when either drifts from the expected
 * total. That is all it proves.
 *
 * WHAT THIS PROVES
 *   - no compatibility test was deleted or renamed without updating the
 *     manifest;
 *   - no compatibility test was added without documenting it;
 *   - the documented inventory still has the expected size.
 *
 * WHAT THIS DOES NOT PROVE
 *   - that any test ran;
 *   - that any test passed.
 *   Execution correctness comes from the dedicated CI step:
 *     npx tsx --import ./test/test-env.ts --test test/share-link-compat-*.test.ts
 *   and from `yarn test` for the full suite.
 *
 * Duplicate ids are deliberately NOT an error. An id is legitimately named by
 * more than one test and referenced repeatedly in the manifest prose, so both
 * sides are compared as SETS.
 *
 * Node built-ins only. Run locally with:
 *   node scripts/ci/check-compat-manifest.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const TEST_DIR = path.join(REPO_ROOT, "test");
const MANIFEST = path.join(
  REPO_ROOT,
  "docs",
  "SHARE_LINK_COMPATIBILITY_TESTS.md",
);
const TEST_FILE_PATTERN = /^share-link-compat-.*\.test\.ts$/;
const ID_PATTERN = /COMPAT-\d+/g;

/** The agreed Wave A inventory size. Change this only with a real review. */
const EXPECTED_ID_COUNT = 31;

function fail(message, detail) {
  console.error(`::error::${message}`);
  if (detail) console.error(detail);
  process.exitCode = 1;
}

function idsIn(text) {
  return new Set(text.match(ID_PATTERN) ?? []);
}

function sorted(set) {
  return [...set].sort();
}

let testFiles;
try {
  testFiles = readdirSync(TEST_DIR)
    .filter((name) => TEST_FILE_PATTERN.test(name))
    .sort();
} catch (error) {
  fail(`Cannot read ${TEST_DIR}: ${error.message}`);
  process.exit(1);
}

if (testFiles.length === 0) {
  fail(
    "No test/share-link-compat-*.test.ts files found.",
    "The Wave A compatibility suites are missing from this checkout.",
  );
  process.exit(1);
}

const sourceIds = new Set();
for (const name of testFiles) {
  for (const id of idsIn(readFileSync(path.join(TEST_DIR, name), "utf8"))) {
    sourceIds.add(id);
  }
}

let manifestText;
try {
  manifestText = readFileSync(MANIFEST, "utf8");
} catch {
  fail(
    `${path.relative(REPO_ROOT, MANIFEST)} is missing from the checkout.`,
    "The compatibility manifest must be committed alongside the CI workflow.",
  );
  process.exit(1);
}
const manifestIds = idsIn(manifestText);

const undocumented = sorted(sourceIds).filter((id) => !manifestIds.has(id));
const unimplemented = sorted(manifestIds).filter((id) => !sourceIds.has(id));

if (undocumented.length > 0) {
  fail(
    "Compatibility ids exist in the tests but are not documented in the manifest.",
    `  ${undocumented.join(", ")}`,
  );
}

if (unimplemented.length > 0) {
  fail(
    "Compatibility ids are documented in the manifest but no test names them.",
    `  ${unimplemented.join(", ")}\n` +
      "  A test was deleted, renamed, or its id was changed.",
  );
}

if (sourceIds.size !== EXPECTED_ID_COUNT) {
  fail(
    `Expected exactly ${EXPECTED_ID_COUNT} distinct compatibility ids in the ` +
      `test sources, found ${sourceIds.size}.`,
    "If the inventory genuinely changed, update EXPECTED_ID_COUNT in this " +
      "script in the same reviewed change.",
  );
}

if (process.exitCode === 1) {
  console.error("");
  console.error(`source   (${sourceIds.size}): ${sorted(sourceIds).join(" ")}`);
  console.error(
    `manifest (${manifestIds.size}): ${sorted(manifestIds).join(" ")}`,
  );
  process.exit(1);
}

console.log(
  `Manifest consistent: ${sourceIds.size} compatibility ids across ` +
    `${testFiles.length} test file(s), all documented.`,
);
console.log(`  files: ${testFiles.join(", ")}`);
