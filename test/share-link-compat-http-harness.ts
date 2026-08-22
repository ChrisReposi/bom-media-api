/**
 * TEST-HARNESS INTERNAL - transpiler compensation for the HTTP suites.
 *
 * `yarn test` runs through `tsx`/esbuild, which does not implement
 * `emitDecoratorMetadata`. The production build does (`tsconfig.json`), so at
 * runtime Nest resolves a controller's constructor from the `design:paramtypes`
 * metadata the TypeScript compiler emits — metadata that simply does not exist
 * under esbuild. Supplying the same list the compiler would emit is a
 * transpiler compensation; it changes no behaviour.
 *
 * **This is not a compatibility contract.** Adding a constructor dependency to a
 * controller does not break a single share link, so it must never fail a
 * release gate. What it does break is this harness, which cannot invent an
 * injection token for a parameter it has never heard of. When that happens the
 * error below says so in as many words, so the failure is triaged as harness
 * maintenance rather than mistaken for a share-link regression.
 */

/** Nest reads constructor dependencies from this well-known metadata key. */
const PARAMTYPES_METADATA = "design:paramtypes";

/**
 * Declares the injection tokens for a controller's constructor so a Nest
 * testing module can instantiate it under esbuild.
 *
 * @param controller The controller class Nest will construct.
 * @param tokens     Injection tokens, in constructor order.
 */
export function defineControllerParamTypes(
  controller: new (...args: never[]) => unknown,
  tokens: readonly unknown[],
): void {
  if (controller.length > tokens.length) {
    throw new Error(
      [
        `TEST HARNESS MAINTENANCE REQUIRED (not a compatibility regression):`,
        `${controller.name} now takes ${controller.length} constructor`,
        `parameters but this harness only knows ${tokens.length} injection`,
        `token(s). Add the new token to the caller in`,
        `test/share-link-compat-http.test.ts / test/share-link-compat-routes.test.ts.`,
        `Adding a controller dependency does not affect share-link`,
        `compatibility - do not treat this as a release blocker.`,
      ].join(" "),
    );
  }

  Reflect.defineMetadata(PARAMTYPES_METADATA, [...tokens], controller);
}
