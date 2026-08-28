/**
 * Read-only probe for the public Bunny thumbnail proxy's UPSTREAM leg.
 *
 * WHAT IT ANSWERS. "With the configuration this deployment actually has, does
 * the pull zone serve a poster to THIS server?" That is the one question the
 * unit tests cannot answer, because they mock `globalThis.fetch` — deliberately,
 * so CI never depends on Bunny's availability.
 *
 * A proxy that merely moves the browser's 403 to the API server is not a fix,
 * and this is how an operator proves it did not happen, before enabling the
 * feature for reviewers.
 *
 * WHAT IT DOES NOT DO. It performs exactly ONE outbound GET, to a URL rebuilt
 * by the same validator the production path uses. It touches no database, reads
 * no share link, mints no credential, and writes nothing anywhere. It never
 * prints `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_TOKEN_SECURITY_KEY`, a share
 * token, an alias or a media grant — none of those are even read.
 *
 * Usage:
 *   yarn diagnose:bunny-thumbnail --bunny-video-id <guid> --file-name <name>
 *   yarn diagnose:bunny-thumbnail --config-only        # no network request
 *
 * The video id and file name come from an admin video detail page:
 * `providerAssetId` and the last path segment of `thumbnailUrl`.
 */
import { loadApiEnv } from "../../src/config/load-env";
import {
  BUNNY_THUMBNAIL_PROXY_AUTH_MODES,
  DEFAULT_BUNNY_THUMBNAIL_PROXY_TIMEOUT_MS,
} from "../../src/bunny/bunny-stream.constants";
import {
  isAllowedProxyImageType,
  resolveBunnyThumbnailUpstreamUrl,
} from "../../src/bunny/bunny-cdn-thumbnail.util";
import { isBunnyPullZoneHostname } from "../../src/bunny/bunny-thumbnail.util";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * The Referer is a PUBLIC site URL, not a secret — it is the value a browser
 * would have sent. Even so, only its origin is printed: the configured value
 * could carry a path an operator did not intend to paste into a terminal.
 */
function describeReferer(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    return "(not set)";
  }
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:") {
      return `INVALID (not https): ${parsed.protocol}//…`;
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return "INVALID (embedded credentials)";
    }
    return `${parsed.origin}/ (valid)`;
  } catch {
    return "INVALID (unparseable)";
  }
}

async function main(): Promise<void> {
  loadApiEnv();

  const proxyEnabled =
    process.env.BUNNY_PUBLIC_THUMBNAIL_PROXY_ENABLED === "true" ||
    process.env.BUNNY_PUBLIC_THUMBNAIL_PROXY_ENABLED === "1";
  const authMode =
    process.env.BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_AUTH_MODE?.trim().toLowerCase() ||
    BUNNY_THUMBNAIL_PROXY_AUTH_MODES.none;
  const referer = process.env.BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_REFERER;
  const pullZoneHostname =
    process.env.BUNNY_STREAM_PULL_ZONE_HOSTNAME?.trim().toLowerCase() ?? "";

  console.log("=== Bunny public thumbnail proxy — configuration ===");
  console.log(
    `BUNNY_STREAM_ENABLED                      : ${process.env.BUNNY_STREAM_ENABLED ?? "(unset)"}`,
  );
  console.log(
    `BUNNY_STREAM_PULL_ZONE_HOSTNAME           : ${pullZoneHostname || "(unset)"}`,
  );
  console.log(
    `  hostname shape valid                    : ${isBunnyPullZoneHostname(pullZoneHostname)}`,
  );
  console.log(`BUNNY_PUBLIC_THUMBNAIL_PROXY_ENABLED      : ${proxyEnabled}`);
  console.log(`BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_AUTH_MODE : ${authMode}`);
  console.log(
    `BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_REFERER   : ${describeReferer(referer)}`,
  );
  console.log(
    `BUNNY_PUBLIC_THUMBNAIL_MAX_BYTES          : ${process.env.BUNNY_PUBLIC_THUMBNAIL_MAX_BYTES ?? "(default)"}`,
  );
  console.log(
    `BUNNY_PUBLIC_THUMBNAIL_TIMEOUT_MS         : ${process.env.BUNNY_PUBLIC_THUMBNAIL_TIMEOUT_MS ?? "(default)"}`,
  );
  console.log("Secrets are never read by this script and never printed.");

  if (
    authMode === BUNNY_THUMBNAIL_PROXY_AUTH_MODES.referer &&
    !referer?.trim()
  ) {
    console.log(
      "\nWARNING: auth mode is 'referer' but no Referer is configured. The proxy will FAIL CLOSED and serve no poster.",
    );
  }

  if (process.argv.includes("--config-only")) {
    return;
  }

  const bunnyVideoId = readArg("bunny-video-id");
  const fileName = readArg("file-name");
  if (!bunnyVideoId || !fileName) {
    console.log(
      "\nNo --bunny-video-id / --file-name supplied; skipping the network probe. Re-run with both, or with --config-only.",
    );
    return;
  }
  if (!isBunnyPullZoneHostname(pullZoneHostname)) {
    throw new Error(
      "BUNNY_STREAM_PULL_ZONE_HOSTNAME is missing or malformed; cannot build an upstream URL.",
    );
  }

  // The SAME validator the production path uses. If this refuses, the route
  // would have refused too — which is itself the answer.
  const resolved = resolveBunnyThumbnailUpstreamUrl(
    `https://${pullZoneHostname}/${encodeURIComponent(bunnyVideoId)}/${encodeURIComponent(fileName)}`,
    { bunnyVideoId, pullZoneHostname },
  );
  if (!resolved.ok) {
    console.log(`\nUPSTREAM URL REJECTED BY VALIDATION: ${resolved.reason}`);
    process.exitCode = 1;
    return;
  }

  const headers: Record<string, string> = {
    Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
  };
  if (
    authMode === BUNNY_THUMBNAIL_PROXY_AUTH_MODES.referer &&
    referer?.trim()
  ) {
    headers.Referer = referer.trim();
  }

  console.log("\n=== Upstream probe (ONE read-only GET) ===");
  console.log(
    `URL       : https://${pullZoneHostname}/${bunnyVideoId}/${fileName}`,
  );
  console.log(
    `Referer   : ${headers.Referer ? "sent (configured value)" : "not sent"}`,
  );

  let response: Response;
  try {
    response = await fetch(resolved.url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(DEFAULT_BUNNY_THUMBNAIL_PROXY_TIMEOUT_MS),
    });
  } catch (error) {
    console.log(
      `RESULT    : UNREACHABLE (${error instanceof Error ? error.name : "UnknownError"})`,
    );
    process.exitCode = 1;
    return;
  }

  const contentType = response.headers.get("content-type");
  const contentLength = response.headers.get("content-length");
  // Release the socket without reading the image into memory.
  await response.body?.cancel().catch(() => undefined);

  console.log(`Status    : ${response.status}`);
  console.log(`Content-Type  : ${contentType ?? "(absent)"}`);
  console.log(`Content-Length: ${contentLength ?? "(absent)"}`);

  const servable = response.ok && isAllowedProxyImageType(contentType);
  console.log(
    `\nVERDICT   : ${servable ? "PASS - the proxy would serve this poster" : "FAIL"}`,
  );

  if (!servable) {
    if (response.status === 401 || response.status === 403) {
      console.log(
        "  The pull zone refused THIS SERVER. If the zone uses Allowed Referrers, set",
      );
      console.log(
        "  BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_AUTH_MODE=referer and a matching",
      );
      console.log(
        "  BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_REFERER, then re-run. Enabling the proxy",
      );
      console.log(
        "  without fixing this would only move the 403 to the API server.",
      );
    } else if (response.status >= 300 && response.status < 400) {
      console.log(
        "  A redirect. The proxy never follows one, so this poster would be refused.",
      );
    } else if (response.status === 404) {
      console.log(
        "  Not found. Check the file name against the admin video's thumbnailUrl.",
      );
    } else if (!isAllowedProxyImageType(contentType)) {
      console.log(
        "  The response is not an allowed raster image type (SVG is excluded by design).",
      );
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Bunny thumbnail probe failed.",
    );
    process.exitCode = 1;
  });
}
