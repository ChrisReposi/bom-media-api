import { Prisma } from "../../generated/prisma/client";

/**
 * Prisma reports P2002 unique violations in two shapes depending on the
 * engine: the classic `meta.target` (string or array), and — with driver
 * adapters such as @prisma/adapter-mariadb — only
 * `meta.driverAdapterError.cause.constraint.index` (proven by probing MySQL
 * 1062 through the live adapter; `meta.target` is absent there). Every
 * collision matcher must consult both shapes or retries silently break.
 */
function uniqueConstraintIdentifiers(error: unknown): string[] {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return [];
  }

  const identifiers: string[] = [];
  const meta = error.meta as
    | {
        target?: unknown;
        driverAdapterError?: {
          cause?: { constraint?: { index?: unknown; fields?: unknown } };
        };
      }
    | undefined;

  const target = meta?.target;
  if (Array.isArray(target)) {
    identifiers.push(...target.map(String));
  } else if (typeof target === "string") {
    identifiers.push(target);
  }

  const constraint = meta?.driverAdapterError?.cause?.constraint;
  if (typeof constraint?.index === "string") {
    identifiers.push(constraint.index);
  }
  if (Array.isArray(constraint?.fields)) {
    identifiers.push(...constraint.fields.map(String));
  }

  return identifiers;
}

/** True when the P2002 violation involves the given column/index fragment. */
export function isUniqueViolationOn(error: unknown, needle: string): boolean {
  return uniqueConstraintIdentifiers(error).some((identifier) =>
    identifier.includes(needle),
  );
}

/**
 * True when a Prisma unique violation hit the ShareLink alias or tokenHash
 * columns — the only collisions that should trigger a regenerate-and-retry.
 * Pure so both the generic and the canonical share-link services can share
 * the policy without coupling to each other's internals.
 */
export function isShareLinkTokenOrAliasCollision(error: unknown): boolean {
  return (
    isUniqueViolationOn(error, "alias") ||
    isUniqueViolationOn(error, "tokenHash")
  );
}
