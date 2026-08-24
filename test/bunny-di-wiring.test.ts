/**
 * BUNNY COLLABORATOR DI WIRING — the runtime blocker this suite prevents.
 *
 * THE BUG. `VideosService` declared its Bunny collaborator as
 *
 *     import type { BunnyStreamService } from "../bunny/bunny-stream.service";
 *     ...
 *     @Optional() private readonly bunnyStreamService?: BunnyStreamService,
 *
 * `import type` is ERASED from the emitted JavaScript. Nest resolves a
 * constructor parameter from the `design:paramtypes` metadata TypeScript emits
 * under `emitDecoratorMetadata`, and that metadata can only name a class that
 * still exists at runtime. With the import erased, the emitted entry degraded
 * to a bare `Function`, which matches no provider.
 *
 * Because the parameter is `@Optional()`, THAT FAILURE WAS SILENT. Nest injected
 * `undefined`, the container booted cleanly, and every Bunny path on
 * `VideosService` — upload-init, status sync, custom thumbnail, admin preview
 * and purge — failed at runtime with
 *
 *     400 "Bunny Stream is not enabled."
 *
 * on a server where `BUNNY_STREAM_ENABLED=true` and every Bunny credential was
 * present and valid. `PublicService` used a VALUE import for the same class, so
 * public playback signing kept working — which is what made the fault look like
 * a purge-specific configuration problem rather than a DI defect.
 *
 * WHY THE EXISTING SUITES COULD NOT CATCH IT. Every Bunny test constructs
 * `VideosService` positionally — `new VideosService(..., bunnyStub)` — which
 * bypasses the container entirely.
 *
 * WHY THIS SUITE READS SOURCE RATHER THAN METADATA. `yarn test` runs through
 * `tsx`/esbuild, which does NOT implement `emitDecoratorMetadata` (the same
 * limitation `share-link-compat-http-harness.ts` shims around). Under the test
 * runner `design:paramtypes` is EMPTY for every decorated class, so asserting it
 * there would test the harness, not production. The import form is the actual
 * cause and is checked with TypeScript's own parser — not a regex — so
 * formatting, comments and import order cannot produce a false result.
 *
 * The compiled `dist/` build IS the artefact production runs, so when it is
 * present the real metadata is asserted too. It is skipped rather than failed
 * when absent, because CI runs the tests before `yarn build`.
 *
 * ESLint's `consistent-type-imports` rule will keep offering to rewrite that
 * import back to `import type`. If anyone applies it, THIS SUITE FAILS.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

const SRC_ROOT = join(__dirname, "..", "src");
const DIST_ROOT = join(__dirname, "..", "dist");

const BUNNY_SERVICE_MODULE = "bunny-stream.service";
const BUNNY_SERVICE_CLASS = "BunnyStreamService";

/**
 * Services that inject the Bunny collaborator, and where they live.
 *
 * Both are listed on purpose. One working and one silently broken is the
 * hardest version of this fault to diagnose, so they are pinned together.
 */
const INJECTING_SERVICES = [
  {
    label: "VideosService",
    sourceFile: join(SRC_ROOT, "videos", "videos.service.ts"),
    distFile: join(DIST_ROOT, "videos", "videos.service.js"),
    exportName: "VideosService",
  },
  {
    label: "PublicService",
    sourceFile: join(SRC_ROOT, "public", "public.service.ts"),
    distFile: join(DIST_ROOT, "public", "public.service.js"),
    exportName: "PublicService",
  },
] as const;

type BunnyImportUsage = {
  /** The class is imported somewhere in the file, in any form. */
  imported: boolean;
  /** It survives compilation as a runtime value. */
  isValueImport: boolean;
  /** It is erased — either a type-only clause or a type-only specifier. */
  isTypeOnlyImport: boolean;
};

/**
 * Reads how `BunnyStreamService` is imported, using the real TypeScript parser.
 *
 * Both erasure forms are detected: a type-only CLAUSE
 * (`import type { X } from`) and a type-only SPECIFIER
 * (`import { type X } from`). Either one removes the runtime value.
 */
function readBunnyImportUsage(sourceFilePath: string): BunnyImportUsage {
  const source = ts.createSourceFile(
    sourceFilePath,
    readFileSync(sourceFilePath, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );

  const usage: BunnyImportUsage = {
    imported: false,
    isValueImport: false,
    isTypeOnlyImport: false,
  };

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    const moduleSpecifier = statement.moduleSpecifier;
    if (
      !ts.isStringLiteral(moduleSpecifier) ||
      !moduleSpecifier.text.endsWith(BUNNY_SERVICE_MODULE)
    ) {
      continue;
    }

    const clause = statement.importClause;
    if (clause === undefined) {
      continue;
    }

    const bindings = clause.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }

    for (const element of bindings.elements) {
      if (element.name.text !== BUNNY_SERVICE_CLASS) {
        continue;
      }

      usage.imported = true;

      if (clause.isTypeOnly || element.isTypeOnly) {
        usage.isTypeOnlyImport = true;
      } else {
        usage.isValueImport = true;
      }
    }
  }

  return usage;
}

/* ------------------------------------------------------------------ *
 * The import form — the actual cause, checked in every environment
 * ------------------------------------------------------------------ */

describe("Bunny collaborator DI wiring", () => {
  for (const service of INJECTING_SERVICES) {
    it(`${service.label} imports BunnyStreamService as a runtime VALUE`, () => {
      const usage = readBunnyImportUsage(service.sourceFile);

      assert.equal(
        usage.imported,
        true,
        `${service.label} must import ${BUNNY_SERVICE_CLASS} to inject it`,
      );

      assert.equal(
        usage.isTypeOnlyImport,
        false,
        [
          `${service.label} imports ${BUNNY_SERVICE_CLASS} as a TYPE ONLY.`,
          "",
          "TypeScript erases that import, so the emitted design:paramtypes",
          "entry degrades to a bare Function and Nest cannot match it to the",
          "provider exported by BunnyStreamModule. The parameter is",
          "@Optional(), so Nest injects undefined SILENTLY and the container",
          "still boots — then every Bunny path fails at runtime with",
          '"Bunny Stream is not enabled." even though Bunny is fully',
          "configured and enabled.",
          "",
          "Use a value import. Do not apply ESLint consistent-type-imports here.",
        ].join("\n"),
      );

      assert.equal(
        usage.isValueImport,
        true,
        `${service.label} must import ${BUNNY_SERVICE_CLASS} as a value`,
      );
    });
  }

  it("the two services agree — neither can silently lose its collaborator", () => {
    // The incident signature: public signing worked while every admin and
    // purge path was broken, which is why it read as a config problem.
    for (const service of INJECTING_SERVICES) {
      const usage = readBunnyImportUsage(service.sourceFile);
      assert.equal(
        usage.isValueImport && !usage.isTypeOnlyImport,
        true,
        `${service.label} must resolve the same runtime BunnyStreamService`,
      );
    }
  });

  it("BunnyStreamService is a real injectable class with the guarded methods", () => {
    // `isEnabled()` is what the purge availability guard calls before it lets a
    // remote-deleting purge proceed; `deleteVideo()` is the remote delete.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require("../src/bunny/bunny-stream.service") as {
      BunnyStreamService: new (...args: never[]) => unknown;
    };

    assert.equal(typeof loaded.BunnyStreamService, "function");
    assert.equal(loaded.BunnyStreamService.name, BUNNY_SERVICE_CLASS);
    assert.equal(
      typeof loaded.BunnyStreamService.prototype.isEnabled,
      "function",
    );
    assert.equal(
      typeof loaded.BunnyStreamService.prototype.deleteVideo,
      "function",
    );
  });

  /* ---------------------------------------------------------------- *
   * The compiled artefact — the strongest proof, when it exists
   * ---------------------------------------------------------------- */

  it("the COMPILED build carries resolvable Bunny metadata", (context) => {
    const built = INJECTING_SERVICES.every((service) =>
      existsSync(service.distFile),
    );

    if (!built) {
      // CI runs the tests before `yarn build`, so absence is expected there.
      // Run `yarn build` first to exercise this assertion locally.
      context.skip("dist/ not built; run yarn build to assert real metadata");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BunnyStreamService: CompiledBunnyStreamService } = require(
      join(DIST_ROOT, "bunny", "bunny-stream.service.js"),
    ) as Record<string, unknown>;

    for (const service of INJECTING_SERVICES) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const compiled = require(service.distFile) as Record<string, unknown>;
      const target = compiled[service.exportName] as object;
      const paramTypes = (Reflect.getMetadata("design:paramtypes", target) ??
        []) as unknown[];
      const names = paramTypes.map((type) =>
        typeof type === "function" ? type.name : String(type),
      );

      assert.ok(
        paramTypes.includes(CompiledBunnyStreamService),
        [
          `${service.label} (compiled) must carry the real BunnyStreamService`,
          "class in design:paramtypes so Nest can inject the provider.",
          "",
          `Got: [${names.join(", ")}]`,
          "",
          'A bare "Function" or "Object" is the erased-import signature.',
        ].join("\n"),
      );
    }
  });
});
