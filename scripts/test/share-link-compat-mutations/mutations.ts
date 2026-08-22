/**
 * Mutation definitions for the share-link compatibility suite.
 *
 * TEST-ONLY TOOLING. Nothing here runs during `yarn test` or in CI. Each entry
 * describes one deliberate, temporary edit to production source that a specific
 * compatibility test must detect. The runner applies exactly one at a time and
 * restores the file afterwards - see `run.ts`.
 *
 * Rules for adding a mutation:
 *  - `apply` MUST assert it matched exactly what it expected, so a refactor
 *    turns into a loud "mutation no longer applies" rather than a silent no-op;
 *  - `expectFailingTests` names the suite(s) that must go red;
 *  - `expectFailingPattern` names a test title that must appear in the failure
 *    output, so a mutation cannot be considered "caught" by an unrelated break.
 */

export type Mutation = {
  id: string;
  description: string;
  /** Repository-relative path of the file to mutate. */
  file: string;
  /** Test files that must fail while this mutation is applied. */
  expectFailingTests: string[];
  /** A test title that must appear among the failures. */
  expectFailingPattern: RegExp;
  /** Returns the mutated source. Must throw if it cannot match. */
  apply: (source: string) => string;
};

const PUBLIC_SERVICE = "src/public/public.service.ts";
const PUBLIC_CONTROLLER = "src/public/public.controller.ts";
const GRANT_SERVICE = "src/public/public-media-grant.service.ts";
const SHARE_TOKEN_UTIL = "src/public/utils/share-token.util.ts";
const ADMIN_WEBSITES_SERVICE = "src/admin-websites/admin-websites.service.ts";
const VIDEOS_SERVICE = "src/videos/videos.service.ts";
const APP_MODULE = "src/app.module.ts";

const RESOLUTION = "test/share-link-compat-resolution.test.ts";
const MEDIA_DELIVERY = "test/share-link-compat-media-delivery.test.ts";
const CACHE_GRANTS = "test/share-link-compat-cache-grants.test.ts";
const HTTP = "test/share-link-compat-http.test.ts";
const ROUTES = "test/share-link-compat-routes.test.ts";

/** Newline-agnostic single-occurrence replacement. */
function replaceOnce(source: string, find: string, replace: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const needle = find.replace(/\n/g, newline);
  const occurrences = source.split(needle).length - 1;

  if (occurrences !== 1) {
    throw new Error(
      `expected exactly 1 occurrence, found ${occurrences}: ${find.slice(0, 60)}...`,
    );
  }

  return source.replace(needle, replace.replace(/\n/g, newline));
}

/** Deletes one line (with its terminator), asserting the expected count. */
function deleteLines(
  source: string,
  line: string,
  expectedOccurrences = 1,
): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const needle = `${line}${newline}`;
  const occurrences = source.split(needle).length - 1;

  if (occurrences !== expectedOccurrences) {
    throw new Error(
      `expected ${expectedOccurrences} occurrence(s), found ${occurrences}: ${line.trim()}`,
    );
  }

  return source.split(needle).join("");
}

/** Removes one argument from the media cache-key builder. */
function removeCacheKeyArgument(source: string, argument: string): string {
  const anchor = source.indexOf("buildPublicLocalMediaMetadataCacheKey(");
  if (anchor === -1) {
    throw new Error("buildPublicLocalMediaMetadataCacheKey not found");
  }
  const start = source.indexOf("return buildCacheKey(", anchor);
  const end = source.indexOf(");", start) + 2;
  if (start === -1 || end === 1) {
    throw new Error("cache-key builder body not found");
  }

  const block = source.slice(start, end);

  return source.slice(0, start) + deleteLines(block, argument) + source.slice(end);
}

export const MUTATIONS: Mutation[] = [
  {
    id: "M1",
    description:
      "hashShareToken concatenates token before pepper (algorithm regression)",
    file: SHARE_TOKEN_UTIL,
    expectFailingTests: [RESOLUTION],
    expectFailingPattern: /independently stored hash/,
    apply: (source) =>
      replaceOnce(
        source,
        ".update(`${params.pepper}${params.token}`, \"utf8\")",
        ".update(`${params.token}${params.pepper}`, \"utf8\")",
      ),
  },
  {
    id: "M2",
    description: "watch share-link lookup is no longer scoped by website",
    file: PUBLIC_SERVICE,
    expectFailingTests: [RESOLUTION],
    expectFailingPattern: /another tenant's host/,
    apply: (source) => {
      let next = replaceOnce(
        source,
        "          alias: trimmedToken,\n          websiteId: website.id,",
        "          alias: trimmedToken,",
      );
      next = replaceOnce(
        next,
        "          tokenHash,\n          websiteId: website.id,",
        "          tokenHash,",
      );

      return next;
    },
  },
  {
    id: "M3",
    description: "public watch include no longer orders by sortOrder",
    file: PUBLIC_SERVICE,
    expectFailingTests: [RESOLUTION],
    expectFailingPattern: /sortOrder, not in row order/,
    apply: (source) =>
      replaceOnce(
        source,
        '        orderBy: {\n          sortOrder: "asc" as const,\n        },\n',
        "",
      ),
  },
  {
    id: "M4",
    description:
      "canCachePublicWatchShareLink no longer excludes view-limited links",
    file: PUBLIC_SERVICE,
    expectFailingTests: [CACHE_GRANTS],
    expectFailingPattern: /does not cache authorization for view-limited/,
    apply: (source) =>
      replaceOnce(
        source,
        "    if (shareLink.maxViews !== null) {\n      return false;\n    }\n",
        "",
      ),
  },
  {
    id: "M5-host",
    description: "media cache key drops the host dimension",
    file: PUBLIC_SERVICE,
    expectFailingTests: [CACHE_GRANTS],
    expectFailingPattern: /keys the cache by host/,
    apply: (source) => removeCacheKeyArgument(source, "      host,"),
  },
  {
    id: "M5-credential",
    description: "media cache key drops the credential dimension",
    file: PUBLIC_SERVICE,
    expectFailingTests: [CACHE_GRANTS],
    expectFailingPattern: /keys the cache by credential/,
    apply: (source) =>
      removeCacheKeyArgument(source, "      hashCacheKeyPart(tokenOrAlias),"),
  },
  {
    id: "M5-video",
    description: "media cache key drops the video dimension",
    file: PUBLIC_SERVICE,
    expectFailingTests: [CACHE_GRANTS],
    expectFailingPattern: /keys the cache by video/,
    apply: (source) => removeCacheKeyArgument(source, "      videoId,"),
  },
  {
    id: "M6",
    description: "media grant is no longer bound to the share link id",
    file: GRANT_SERVICE,
    expectFailingTests: [CACHE_GRANTS],
    expectFailingPattern: /from another share link/,
    apply: (source) =>
      deleteLines(source, "        payload.sid === expected.shareLinkId &&"),
  },
  {
    id: "M7",
    description: "media grant expiry is no longer verified",
    file: GRANT_SERVICE,
    expectFailingTests: [CACHE_GRANTS],
    expectFailingPattern: /own expiry has passed/,
    apply: (source) =>
      replaceOnce(
        source,
        "        payload.exp >= nowSeconds",
        "        true",
      ),
  },
  {
    id: "M8",
    description:
      "DB_BLOB controller drops the HEAD short-circuit, so Express rewrites Content-Length to 0",
    file: PUBLIC_CONTROLLER,
    expectFailingTests: [HTTP],
    expectFailingPattern: /full HEAD reports the full resource length/,
    apply: (source) =>
      replaceOnce(
        source,
        '    if (request.method === "HEAD") {\n      response.end();\n      return;\n    }\n',
        "",
      ),
  },
  {
    id: "M8c",
    description: "DB_BLOB controller stops passing headOnly to the service",
    file: PUBLIC_CONTROLLER,
    expectFailingTests: [HTTP, MEDIA_DELIVERY],
    expectFailingPattern: /HEAD/,
    apply: (source) =>
      deleteLines(source, '      headOnly: request.method === "HEAD",'),
  },
  {
    id: "M9",
    description: "DB_BLOB ranged responses report 200 instead of 206",
    file: PUBLIC_SERVICE,
    expectFailingTests: [MEDIA_DELIVERY, HTTP],
    expectFailingPattern: /Range/,
    apply: (source) =>
      replaceOnce(
        source,
        "      statusCode: range.statusCode,\n      mimeType: binaryAsset.mimeType,",
        "      statusCode: 200 as const,\n      mimeType: binaryAsset.mimeType,",
      ),
  },
  {
    id: "M10",
    description: "revokeShareLink no longer invalidates public access caches",
    file: ADMIN_WEBSITES_SERVICE,
    expectFailingTests: [CACHE_GRANTS],
    expectFailingPattern: /share revocation through AdminWebsitesService/,
    apply: (source) =>
      replaceOnce(
        source,
        '    );\n    this.invalidatePublicAccessCaches();\n\n    return {\n      message: "Share link revoked successfully.",',
        '    );\n\n    return {\n      message: "Share link revoked successfully.",',
      ),
  },
  {
    id: "M11",
    description: "VideosService no longer clears the media metadata cache",
    file: VIDEOS_SERVICE,
    expectFailingTests: [CACHE_GRANTS],
    expectFailingPattern: /disabling a video through VideosService/,
    apply: (source) =>
      deleteLines(
        source,
        '    this.memoryCache?.deleteByPrefix("media:metadata:");',
      ),
  },
  {
    id: "M12",
    description: "AppModule no longer imports PublicModule",
    file: APP_MODULE,
    expectFailingTests: [ROUTES],
    expectFailingPattern: /PublicModule registered in AppModule/,
    apply: (source) => deleteLines(source, "    PublicModule,"),
  },
];
