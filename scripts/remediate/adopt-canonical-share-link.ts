/**
 * Local-only, confirmation-gated adoption of an existing ShareLink as the
 * canonical mapping for one website+video pair.
 *
 * The OWNER chooses the link (typically the one already cited in DMCA
 * records) after reviewing `yarn audit:canonical-share-links`. Nothing is
 * auto-selected and there is no bulk mode by design.
 *
 * Usage:
 *   yarn remediate:local:adopt-canonical \
 *     --website-id <id> --video-id <id> --share-link-id <id> \
 *     --admin-id <adminUserId> --confirm-local
 *
 * Production adoption stays a manual operator procedure after backup — this
 * command hard-refuses to run outside APP_ENV=local.
 */
import { ConfigService } from "@nestjs/config";
import { loadApiEnv } from "../../src/config/load-env";
import { validateEnv } from "../../src/config/env.validation";
import { apiConfig } from "../../src/config/env.config";
import { PrismaService } from "../../src/database/prisma.service";
import { AdminWebsitesService } from "../../src/admin-websites/admin-websites.service";
import { CanonicalShareLinkService } from "../../src/admin-websites/canonical-share-link.service";

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (found) {
    return found.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  loadApiEnv();
  if (
    process.env.APP_ENV !== "local" ||
    process.env.NODE_ENV === "production"
  ) {
    throw new Error(
      "Canonical adoption command is restricted to APP_ENV=local.",
    );
  }
  if (!process.argv.includes("--confirm-local")) {
    throw new Error(
      "Pass --confirm-local after reviewing the canonical audit worksheet.",
    );
  }

  const websiteId = readArg("website-id")?.trim();
  const videoId = readArg("video-id")?.trim();
  const shareLinkId = readArg("share-link-id")?.trim();
  const adminId = readArg("admin-id")?.trim();
  if (!websiteId || !videoId || !shareLinkId || !adminId) {
    throw new Error(
      "--website-id, --video-id, --share-link-id and --admin-id are all required.",
    );
  }

  const validated = validateEnv(process.env);
  const config = new ConfigService({ ...validated, api: apiConfig() });
  const prisma = new PrismaService(config);
  await prisma.onModuleInit();
  const websitesService = new AdminWebsitesService(prisma, config, {
    clearDomainOriginCache: () => undefined,
  } as never);
  const canonicalService = new CanonicalShareLinkService(
    prisma,
    config,
    websitesService,
  );

  try {
    const result = await canonicalService.adoptExistingShareLink({
      websiteId,
      videoId,
      shareLinkId,
      adminId,
    });
    console.log("Canonical adoption complete.");
    console.log(`  outcome: ${result.outcome}`);
    console.log(`  alias: ${result.alias}`);
    console.log(`  publicUrl: ${result.publicUrl}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Canonical adoption failed.",
    );
    process.exitCode = 1;
  });
}
