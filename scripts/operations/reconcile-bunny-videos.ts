/**
 * Bunny Stream reconciliation.
 *
 *     yarn reconcile:bunny                 # dry run, reports only
 *     yarn reconcile:bunny --apply --confirm-env=local
 *
 * WHY THIS EXISTS. Deleting a video in the Bunny dashboard is an EXTERNAL
 * mutation the CMS never hears about. Bunny Stream's webhook enumerates
 * encoding states only - Queued, Processing, Encoding, Finished, Resolution
 * finished, Failed, the three PresignedUpload states, CaptionsGenerated and
 * TitleOrDescriptionGenerated. **There is no video-deleted event**, verified
 * against https://bunny.net/docs/stream/webhooks. So reconciliation has to be
 * pull-based; inventing a delete webhook was not an option.
 *
 * Per-video Admin Sync already covers the "an operator noticed" case. This
 * covers the "nobody looked" case, in bounded batches at low concurrency.
 *
 * WHAT IT WILL NEVER DO, by construction:
 *
 *   - delete a local row (it calls `update` only - `delete` is never reached)
 *   - delete a Bunny asset (it issues GET only - `deleteVideo` is never called)
 *   - mint a playback token (it never touches `createSignedEmbedUrl`)
 *   - print a secret (only aggregate counts and ids are emitted)
 *
 * It also does not reimplement the lifecycle. The transition rules come from
 * the SAME exported helpers `VideosService.syncBunnyVideoStatus()` uses -
 * `resolveBunnyLocalStatus`, `resolveBunnyRemoteMissingStatus`,
 * `applyBunnyRemoteMissingMarker`, `clearBunnyRemoteMissingMarker` - so the
 * script and the endpoint can never drift apart.
 *
 * A TRANSIENT Bunny failure is counted separately and marks nothing. Only an
 * authoritative 404 means the remote asset is gone.
 *
 * Designed to be cron-safe later (Hostinger cron, `--apply` plus
 * `--confirm-env`). Nothing schedules it today, and no scheduler dependency was
 * added for it.
 */
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import {
  BunnyNotFoundError,
  BunnyStreamService,
} from "../../src/bunny/bunny-stream.service";
import {
  applyBunnyRemoteMissingMarker,
  clearBunnyRemoteMissingMarker,
  isBunnyRemoteMissing,
  readBunnyVideoAsset,
  resolveBunnyLocalStatus,
  resolveBunnyRemoteMissingStatus,
} from "../../src/bunny/bunny-video-asset.util";
import { loadApiEnv } from "../../src/config/load-env";
import {
  AuditStatus,
  PrismaClient,
  VideoProvider,
  VideoSourceType,
  type Prisma,
  type VideoStatus,
} from "../../src/generated/prisma/client";

export type ReconcileOptions = {
  apply: boolean;
  batchSize: number;
  maxBatches: number;
  /** Kept low on purpose - this is a background sweep, not a load test. */
  concurrency: number;
  confirmEnvironment?: string;
};

export type ReconcileSummary = {
  mode: "apply" | "dry-run";
  checked: number;
  available: number;
  remoteMissing: number;
  failedRequests: number;
  updated: number;
  recovered: number;
  skippedNotBunny: number;
};

const KNOWN_ARGUMENTS = [
  "--apply",
  "--batch-size=",
  "--max-batches=",
  "--concurrency=",
  "--confirm-env=",
];

export function parseReconcileOptions(args: string[]): ReconcileOptions {
  const readInt = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const raw = args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`--${name} must be ${min}-${max}.`);
    }
    return value;
  };

  if (
    args.some(
      (arg) =>
        !KNOWN_ARGUMENTS.some((known) =>
          known.endsWith("=") ? arg.startsWith(known) : arg === known,
        ),
    )
  ) {
    throw new Error("Unknown reconcile argument.");
  }

  return {
    apply: args.includes("--apply"),
    batchSize: readInt("batch-size", 50, 1, 500),
    maxBatches: readInt("max-batches", 20, 1, 200),
    // Bounded 1-5. Bunny is a shared external service and this is not urgent
    // work; a higher ceiling would only risk rate limiting for no benefit.
    concurrency: readInt("concurrency", 4, 1, 5),
    confirmEnvironment: args
      .find((arg) => arg.startsWith("--confirm-env="))
      ?.split("=")[1],
  };
}

function createClient(): PrismaClient {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("DATABASE_URL is required.");
  const url = new URL(raw);

  return new PrismaClient({
    adapter: new PrismaMariaDb({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      connectionLimit: 1,
    }),
  });
}

/**
 * A minimal `ConfigService` over `process.env`.
 *
 * `BunnyStreamService` reads its two secrets through this and never returns
 * them, so the script gets the real client - including its enabled gate, its
 * timeout and its 404 handling - without a Nest container.
 */
function createConfigService(): { get: (key: string) => string | undefined } {
  return { get: (key: string): string | undefined => process.env[key] };
}

type BunnyCandidate = {
  id: string;
  status: VideoStatus;
  provider: VideoProvider;
  sourceType: VideoSourceType;
  providerAssetId: string | null;
  playbackId: string | null;
  metadataJson: Prisma.JsonValue | null;
};

type VideoOutcome =
  | { kind: "available"; nextStatus: VideoStatus; recovered: boolean }
  | { kind: "remote-missing"; nextStatus: VideoStatus }
  | { kind: "failed-request" }
  | { kind: "skipped-not-bunny" };

/**
 * Decides what a single video's reconciliation means. Pure with respect to the
 * database: it reads Bunny and returns an outcome, writing nothing.
 */
async function classifyVideo(
  bunny: BunnyStreamService,
  video: BunnyCandidate,
): Promise<VideoOutcome> {
  // The strict predicate, not the provider column. A record merely LABELLED
  // BUNNY, or a malformed one, is left completely alone.
  const asset = readBunnyVideoAsset(video);
  if (asset === null) {
    return { kind: "skipped-not-bunny" };
  }

  try {
    const remote = await bunny.getVideo(asset.bunnyVideoId);

    return {
      kind: "available",
      nextStatus: resolveBunnyLocalStatus(
        video.status,
        bunny.mapProcessingState(remote.status),
      ),
      recovered: isBunnyRemoteMissing(video.metadataJson),
    };
  } catch (error) {
    // ONLY an authoritative 404 means the remote asset is gone. A timeout, a
    // network error, a 401/403, a 429 or a 5xx is transient and must never be
    // allowed to mark an asset missing.
    if (error instanceof BunnyNotFoundError) {
      return {
        kind: "remote-missing",
        nextStatus: resolveBunnyRemoteMissingStatus(video.status),
      };
    }

    return { kind: "failed-request" };
  }
}

/** Applies one outcome. Returns whether the row actually changed. */
async function applyOutcome(
  prisma: PrismaClient,
  video: BunnyCandidate,
  outcome: VideoOutcome,
  now: Date,
): Promise<boolean> {
  if (outcome.kind === "remote-missing") {
    const marked = applyBunnyRemoteMissingMarker(video.metadataJson, now);
    const statusChanged = outcome.nextStatus !== video.status;
    if (!marked.changed && !statusChanged) {
      return false;
    }

    await prisma.videoAsset.update({
      where: { id: video.id },
      data: {
        ...(statusChanged ? { status: outcome.nextStatus } : {}),
        ...(marked.changed
          ? { metadataJson: marked.metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
    await writeAudit(prisma, "VIDEO_BUNNY_REMOTE_MISSING", video.id, {
      previousStatus: video.status,
      nextStatus: outcome.nextStatus,
      remoteResult: "NOT_FOUND",
      source: "reconcile-bunny-videos",
    });

    return true;
  }

  if (outcome.kind === "available") {
    const cleared = outcome.recovered
      ? clearBunnyRemoteMissingMarker(video.metadataJson)
      : { metadata: {}, changed: false };
    const statusChanged = outcome.nextStatus !== video.status;
    if (!cleared.changed && !statusChanged) {
      return false;
    }

    await prisma.videoAsset.update({
      where: { id: video.id },
      data: {
        ...(statusChanged ? { status: outcome.nextStatus } : {}),
        ...(cleared.changed
          ? { metadataJson: cleared.metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
    if (cleared.changed) {
      await writeAudit(prisma, "VIDEO_BUNNY_REMOTE_RECOVERED", video.id, {
        previousStatus: video.status,
        nextStatus: outcome.nextStatus,
        source: "reconcile-bunny-videos",
      });
    }

    return true;
  }

  return false;
}

/**
 * `adminId` is null: this runs unattended, so attributing it to a person would
 * be a lie. The column is nullable for exactly this reason.
 */
async function writeAudit(
  prisma: PrismaClient,
  action: string,
  videoId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminId: null,
        action,
        module: "videos",
        entityType: "VideoAsset",
        entityId: videoId,
        status:
          action === "VIDEO_BUNNY_REMOTE_MISSING"
            ? AuditStatus.FAIL
            : AuditStatus.SUCCESS,
        metadataJson: metadata as Prisma.InputJsonValue,
      },
    });
  } catch {
    // Audit is best effort; a failed log must not abort the sweep.
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await worker(item);
      }
    },
  );

  await Promise.all(runners);

  return results;
}

export async function reconcileBunnyVideos(
  prisma: PrismaClient,
  bunny: BunnyStreamService,
  options: ReconcileOptions,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    mode: options.apply ? "apply" : "dry-run",
    checked: 0,
    available: 0,
    remoteMissing: 0,
    failedRequests: 0,
    updated: 0,
    recovered: 0,
    skippedNotBunny: 0,
  };

  // Cursor paging by id. A purged row simply is not returned - there is no
  // "permanently purged" tombstone to skip, because purge deletes the row.
  let cursorId: string | undefined;

  for (let batch = 0; batch < options.maxBatches; batch += 1) {
    const videos: BunnyCandidate[] = await prisma.videoAsset.findMany({
      where: {
        provider: VideoProvider.BUNNY,
        sourceType: VideoSourceType.EMBED,
        ...(cursorId === undefined ? {} : { id: { gt: cursorId } }),
      },
      orderBy: { id: "asc" },
      take: options.batchSize,
      select: {
        id: true,
        status: true,
        provider: true,
        sourceType: true,
        providerAssetId: true,
        playbackId: true,
        metadataJson: true,
      },
    });

    if (videos.length === 0) break;
    cursorId = videos[videos.length - 1]?.id;

    const outcomes = await mapWithConcurrency(
      videos,
      options.concurrency,
      (video) => classifyVideo(bunny, video),
    );

    const now = new Date();
    for (const [index, outcome] of outcomes.entries()) {
      const video = videos[index];
      if (video === undefined) continue;

      if (outcome.kind === "skipped-not-bunny") {
        summary.skippedNotBunny += 1;
        continue;
      }

      summary.checked += 1;

      if (outcome.kind === "failed-request") {
        summary.failedRequests += 1;
        continue;
      }

      if (outcome.kind === "remote-missing") {
        summary.remoteMissing += 1;
      } else {
        summary.available += 1;
        if (outcome.recovered) summary.recovered += 1;
      }

      const wouldChange =
        outcome.kind === "remote-missing"
          ? applyBunnyRemoteMissingMarker(video.metadataJson, now).changed ||
            outcome.nextStatus !== video.status
          : (outcome.recovered &&
              clearBunnyRemoteMissingMarker(video.metadataJson).changed) ||
            outcome.nextStatus !== video.status;

      if (!wouldChange) continue;

      if (options.apply) {
        if (await applyOutcome(prisma, video, outcome, now)) {
          summary.updated += 1;
        }
      } else {
        summary.updated += 1;
      }
    }
  }

  return summary;
}

async function run(): Promise<void> {
  const options = parseReconcileOptions(process.argv.slice(2));
  loadApiEnv();

  const environment =
    process.env.APP_ENV?.trim() || process.env.NODE_ENV?.trim() || "unknown";
  if (
    options.apply &&
    (!options.confirmEnvironment || options.confirmEnvironment !== environment)
  ) {
    throw new Error(
      "--apply requires --confirm-env matching APP_ENV/NODE_ENV exactly.",
    );
  }

  const bunny = new BunnyStreamService(createConfigService() as never);
  // Fail fast and loudly rather than reporting "0 checked" on a deployment
  // where Bunny is simply switched off.
  bunny.ensureEnabled();

  const prisma = createClient();
  try {
    const summary = await reconcileBunnyVideos(prisma, bunny, options);
    console.info(
      JSON.stringify({
        ...summary,
        environment,
        batchSize: options.batchSize,
        maxBatches: options.maxBatches,
        concurrency: options.concurrency,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Bunny Stream reconciliation failed.",
    );
    process.exitCode = 1;
  });
}
