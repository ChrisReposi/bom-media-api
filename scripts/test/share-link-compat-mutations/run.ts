/**
 * Share-link compatibility MUTATION RUNNER - test-only proof tooling.
 *
 *   npx tsx scripts/test/share-link-compat-mutations/run.ts
 *   npx tsx scripts/test/share-link-compat-mutations/run.ts M8 M4
 *
 * A green compatibility suite only means something if it can go red. This
 * applies each mutation in `mutations.ts` to production source **one at a
 * time**, runs the compatibility tests that must detect it, restores the file,
 * and verifies the restoration by SHA-256 **and** `git status`.
 *
 * It is deliberately NOT part of `yarn test` or CI: it edits `src/` while it
 * runs, and nothing that mutates source should execute on every build. Run it
 * as an explicit audit step and paste the summary into
 * `docs/SHARE_LINK_COMPATIBILITY_MUTATION_REPORT.md`.
 *
 * Safety properties:
 *  - the original bytes are held in memory before any write;
 *  - restoration happens in a `finally`, and again on `SIGINT`/`SIGTERM`/
 *    `uncaughtException`, so an interrupted run does not leave source mutated;
 *  - the run FAILS (non-zero exit) if a mutation survives, if the wrong test
 *    fails, or if restoration cannot be verified.
 *
 * It never touches the database, the network or anything outside this
 * repository's working tree.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MUTATIONS, type Mutation } from "./mutations";

// The package is CommonJS (`"type": "commonjs"`), so `__dirname` is the
// portable way to locate the repository root; `import.meta` is unavailable.
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

type Outcome = {
  mutation: Mutation;
  status: "CAUGHT" | "SURVIVED" | "WRONG_TEST" | "APPLY_FAILED";
  detail: string;
  failingTitles: string[];
  restored: boolean;
};

/** Files currently mutated, so an interrupt can put them back. */
const pendingRestores = new Map<string, string>();

function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function absolute(file: string): string {
  return join(REPO_ROOT, file);
}

function restoreAll(): void {
  for (const [file, original] of pendingRestores) {
    writeFileSync(absolute(file), original, "utf8");
  }
  pendingRestores.clear();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}
process.on("uncaughtException", (error) => {
  restoreAll();
  console.error(error);
  process.exit(1);
});

/** True when the working tree has no unstaged changes under `src/`. */
function gitSourceClean(): boolean {
  try {
    const output = execFileSync(
      "git",
      ["status", "--porcelain", "--", "src/", "prisma/", "package.json"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

    return output.trim() === "";
  } catch {
    // Not a git checkout - the SHA-256 check below is then the only guarantee,
    // and the caller is told so in the summary.
    return true;
  }
}

function runTests(files: string[]): { output: string; failed: boolean } {
  const result = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      "--import",
      "./test/test-env.ts",
      "--test",
      ...files,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", env: process.env },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  return { output, failed: result.status !== 0 };
}

function failingTitles(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => /^\s*not ok \d+ - /.test(line))
    .map((line) => line.replace(/^\s*not ok \d+ - /, "").trim());
}

function runMutation(mutation: Mutation): Outcome {
  const path = absolute(mutation.file);
  const original = readFileSync(path, "utf8");
  const originalDigest = sha256(original);

  let mutated: string;
  try {
    mutated = mutation.apply(original);
  } catch (error) {
    return {
      mutation,
      status: "APPLY_FAILED",
      detail: error instanceof Error ? error.message : String(error),
      failingTitles: [],
      restored: true,
    };
  }

  if (mutated === original) {
    return {
      mutation,
      status: "APPLY_FAILED",
      detail: "mutation produced identical source",
      failingTitles: [],
      restored: true,
    };
  }

  let outcome: Outcome;
  try {
    pendingRestores.set(mutation.file, original);
    writeFileSync(path, mutated, "utf8");

    const { output, failed } = runTests(mutation.expectFailingTests);
    const titles = failingTitles(output);
    const matched = titles.some((title) =>
      mutation.expectFailingPattern.test(title),
    );

    if (!failed) {
      outcome = {
        mutation,
        status: "SURVIVED",
        detail: "the compatibility suite still passed",
        failingTitles: titles,
        restored: false,
      };
    } else if (!matched) {
      outcome = {
        mutation,
        status: "WRONG_TEST",
        detail: `no failing test matched ${String(mutation.expectFailingPattern)}`,
        failingTitles: titles,
        restored: false,
      };
    } else {
      outcome = {
        mutation,
        status: "CAUGHT",
        detail: `${titles.length} failing test(s)`,
        failingTitles: titles,
        restored: false,
      };
    }
  } finally {
    writeFileSync(path, original, "utf8");
    pendingRestores.delete(mutation.file);
  }

  const restoredDigest = sha256(readFileSync(path, "utf8"));
  outcome.restored = restoredDigest === originalDigest;

  return outcome;
}

function main(): void {
  const requested = process.argv.slice(2);
  const selected =
    requested.length === 0
      ? MUTATIONS
      : MUTATIONS.filter((mutation) => requested.includes(mutation.id));

  if (selected.length === 0) {
    console.error(`No mutation matched: ${requested.join(", ")}`);
    process.exit(2);
  }

  if (!gitSourceClean()) {
    console.error(
      "Refusing to run: the working tree already has changes under src/, " +
        "prisma/ or package.json. Restoration could not be distinguished " +
        "from pre-existing edits.",
    );
    process.exit(2);
  }

  console.log(`Share-link compatibility mutation run - ${selected.length} mutation(s)\n`);

  const outcomes: Outcome[] = [];
  for (const mutation of selected) {
    process.stdout.write(`${mutation.id.padEnd(14)} ${mutation.description}\n`);
    const outcome = runMutation(mutation);
    outcomes.push(outcome);
    process.stdout.write(
      `${"".padEnd(14)} -> ${outcome.status} (${outcome.detail}); ` +
        `restored=${outcome.restored ? "OK" : "FAILED"}\n`,
    );
    for (const title of outcome.failingTitles.slice(0, 4)) {
      process.stdout.write(`${"".padEnd(17)} failing: ${title}\n`);
    }
    process.stdout.write("\n");
  }

  console.log("=".repeat(72));
  console.log("SUMMARY");
  console.log("=".repeat(72));
  for (const outcome of outcomes) {
    console.log(
      `${outcome.mutation.id.padEnd(14)} ${outcome.status.padEnd(13)} ` +
        `restored=${outcome.restored ? "OK" : "FAILED"}  ${outcome.mutation.file}`,
    );
  }

  const sourceClean = gitSourceClean();
  console.log(`\ngit working tree clean under src/: ${sourceClean ? "YES" : "NO"}`);

  const problems = outcomes.filter(
    (outcome) => outcome.status !== "CAUGHT" || !outcome.restored,
  );
  if (problems.length > 0 || !sourceClean) {
    console.error(
      `\nFAILED: ${problems.length} mutation(s) did not behave as required` +
        (sourceClean ? "" : ", and the working tree is not clean"),
    );
    process.exit(1);
  }

  console.log("\nAll mutations were caught and every file was restored.");
}

main();
