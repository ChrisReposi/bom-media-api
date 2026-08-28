import { Injectable, Logger } from "@nestjs/common";
import { Readable } from "node:stream";
import { ConfigService } from "@nestjs/config";
import {
  BUNNY_THUMBNAIL_PROXY_AUTH_MODES,
  DEFAULT_BUNNY_THUMBNAIL_PROXY_MAX_BYTES,
  DEFAULT_BUNNY_THUMBNAIL_PROXY_TIMEOUT_MS,
  MAX_BUNNY_THUMBNAIL_PROXY_MAX_BYTES,
  MAX_BUNNY_THUMBNAIL_PROXY_TIMEOUT_MS,
  MIN_BUNNY_THUMBNAIL_PROXY_MAX_BYTES,
  MIN_BUNNY_THUMBNAIL_PROXY_TIMEOUT_MS,
  type BunnyThumbnailProxyAuthMode,
} from "./bunny-stream.constants";
import { isAllowedProxyImageType } from "./bunny-cdn-thumbnail.util";

/**
 * Outcome of an upstream poster fetch. Never carries an upstream body, an
 * upstream header the caller did not ask for, or anything derived from a
 * secret.
 */
export type BunnyThumbnailFetchResult =
  | {
      ok: true;
      contentType: string;
      /** Upstream `Content-Length` when it was present and within the cap. */
      contentLength: number | null;
      stream: NodeJS.ReadableStream;
    }
  | {
      ok: false;
      /** Internal only. The public route maps every value to one 404. */
      reason:
        | "DISABLED"
        | "MISCONFIGURED"
        | "UPSTREAM_UNAUTHORIZED"
        | "UPSTREAM_NOT_FOUND"
        | "UPSTREAM_ERROR"
        | "UPSTREAM_REDIRECT"
        | "UPSTREAM_UNREACHABLE"
        | "CONTENT_TYPE_REJECTED"
        | "TOO_LARGE";
    };

/**
 * The backend half of reviewer-facing Bunny poster delivery.
 *
 * ── WHY A PROXY EXISTS AT ALL ────────────────────────────────────────────────
 *
 * The public watch response used to hand the reviewer's browser the raw
 * `https://vz-….b-cdn.net/…` poster URL. Worldfold sends
 * `Referrer-Policy: no-referrer` on every response — a deliberate, documented
 * privacy property — so the browser sent no `Referer`, and the pull zone's
 * hotlink protection refused with 403. Two correct decisions meeting.
 *
 * Moving the fetch to the backend fixes it at the architecture level rather
 * than by weakening either side: the reviewer's browser talks only to this API
 * (share-authorized, revocable, no reviewer IP disclosed to Bunny), and this
 * service performs the one upstream request under an EXPLICITLY CONFIGURED
 * authorization mode.
 *
 * ── THE UPSTREAM AUTHORIZATION MODE IS THE WHOLE POINT ───────────────────────
 *
 * A proxy that simply moves the same 403 from the browser to the API server is
 * not a fix. Whatever the pull zone enforces, THIS request must satisfy it, so
 * the mode is configuration and never a guess:
 *
 *   `none`    — the pull zone is open, or restricted by something this backend
 *               already satisfies (an IP allowlist, for instance). Nothing extra
 *               is sent. This is the DEFAULT, so an existing deployment's
 *               behaviour does not change until an operator opts in.
 *
 *   `referer` — the pull zone enforces Bunny's Allowed Referrers (hotlink
 *               protection). The backend sends the configured
 *               `BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_REFERER` verbatim on this one
 *               request. The value comes from validated configuration and NEVER
 *               from the incoming request: echoing a client-supplied Referer
 *               would let a caller choose what the CDN sees, which is not a
 *               mechanism, it is a hole.
 *
 * CDN Token Authentication is NOT implemented — see
 * `docs/features/bunny-stream.md` §11. It would need a CDN token security key
 * that is not part of this deployment's environment contract, and it is a
 * DIFFERENT mechanism from `BUNNY_STREAM_TOKEN_SECURITY_KEY`, which signs
 * Stream EMBED view tokens. Reusing the embed key to sign CDN URLs would
 * produce signatures the CDN rejects while looking, in code, exactly like
 * working security. If the zone is later switched to token authentication, a
 * new mode and a new key are required, and this file is where they go.
 *
 * ── WHAT THIS SERVICE WILL NOT DO ────────────────────────────────────────────
 *
 * It does not choose the URL. The caller passes a URL already rebuilt from
 * proven Bunny identity by `resolveBunnyThumbnailUpstreamUrl()`, so this is not
 * a general-purpose fetcher and cannot be turned into one by a database value.
 */
@Injectable()
export class BunnyThumbnailProxyService {
  private readonly logger = new Logger(BunnyThumbnailProxyService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Whether the backend-mediated poster route is turned on for this deployment.
   *
   * A pure configuration check that mints nothing, so the public serializer can
   * decide which URL shape to return without performing any I/O.
   */
  isEnabled(): boolean {
    const value = this.configService.get<string>(
      "BUNNY_PUBLIC_THUMBNAIL_PROXY_ENABLED",
    );

    return value === "true" || value === "1";
  }

  /** The configured upstream authorization mode. Never inferred. */
  getUpstreamAuthMode(): BunnyThumbnailProxyAuthMode {
    const value = this.configService
      .get<string>("BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_AUTH_MODE")
      ?.trim()
      .toLowerCase();

    return value === BUNNY_THUMBNAIL_PROXY_AUTH_MODES.referer
      ? BUNNY_THUMBNAIL_PROXY_AUTH_MODES.referer
      : BUNNY_THUMBNAIL_PROXY_AUTH_MODES.none;
  }

  /**
   * Fetches one validated Bunny poster.
   *
   * `upstreamUrl` MUST come from `resolveBunnyThumbnailUpstreamUrl()`. This
   * method re-checks nothing about the URL's shape and is not a safe place to
   * pass a stored database value directly.
   */
  async fetchThumbnail(
    upstreamUrl: string,
  ): Promise<BunnyThumbnailFetchResult> {
    if (!this.isEnabled()) {
      return { ok: false, reason: "DISABLED" };
    }

    const mode = this.getUpstreamAuthMode();
    const headers: Record<string, string> = {
      // Ask for what we are willing to accept. The response is still validated
      // — a CDN is free to ignore this.
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
    };

    if (mode === BUNNY_THUMBNAIL_PROXY_AUTH_MODES.referer) {
      const referer = this.getConfiguredReferer();
      if (referer === null) {
        // Fail closed and loudly rather than silently downgrading to `none`,
        // which would send an unauthenticated request and produce a confusing
        // 403 that looks like a Bunny problem.
        this.logger.error(
          "BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_AUTH_MODE=referer requires a valid BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_REFERER.",
        );
        return { ok: false, reason: "MISCONFIGURED" };
      }
      headers.Referer = referer;
    }

    const maxBytes = this.getMaxBytes();
    let response: Response;

    try {
      response = await fetch(upstreamUrl, {
        method: "GET",
        headers,
        // REDIRECTS ARE NEVER FOLLOWED. A 3xx is the one way a URL that passed
        // every hostname check still ends up fetching a different origin, so a
        // redirect is an outright refusal rather than something to re-validate.
        redirect: "manual",
        signal: AbortSignal.timeout(this.getTimeoutMs()),
      });
    } catch (error) {
      this.logger.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Bunny poster upstream request failed before a response was received.",
      );

      return { ok: false, reason: "UPSTREAM_UNREACHABLE" };
    }

    if (response.status >= 300 && response.status < 400) {
      await this.discardBody(response);
      this.logger.warn(
        { bunnyStatusCode: response.status },
        "Bunny poster upstream answered with a redirect; refusing to follow it.",
      );

      return { ok: false, reason: "UPSTREAM_REDIRECT" };
    }

    if (!response.ok) {
      await this.discardBody(response);
      // 401/403 is the signature of an upstream authorization problem — most
      // likely hotlink protection with the wrong mode configured. Logged with
      // the status only: no URL, no header value, no secret.
      const reason =
        response.status === 401 || response.status === 403
          ? ("UPSTREAM_UNAUTHORIZED" as const)
          : response.status === 404
            ? ("UPSTREAM_NOT_FOUND" as const)
            : ("UPSTREAM_ERROR" as const);

      this.logger[reason === "UPSTREAM_NOT_FOUND" ? "warn" : "error"](
        { bunnyStatusCode: response.status, upstreamAuthMode: mode },
        "Bunny poster upstream returned an error status.",
      );

      return { ok: false, reason };
    }

    const contentType = response.headers.get("content-type");
    if (!isAllowedProxyImageType(contentType)) {
      await this.discardBody(response);
      this.logger.warn(
        { upstreamAuthMode: mode },
        "Bunny poster upstream returned a content type this route does not serve.",
      );

      return { ok: false, reason: "CONTENT_TYPE_REJECTED" };
    }

    const declaredLength = this.readContentLength(response);
    if (declaredLength !== null && declaredLength > maxBytes) {
      await this.discardBody(response);

      return { ok: false, reason: "TOO_LARGE" };
    }

    if (response.body === null) {
      return { ok: false, reason: "UPSTREAM_ERROR" };
    }

    return {
      ok: true,
      // Normalised, so the header this API emits is the media type it validated
      // rather than whatever parameters the CDN attached.
      contentType: (contentType ?? "").split(";", 1)[0].trim().toLowerCase(),
      contentLength: declaredLength,
      // The cap is enforced on the BYTES, not just the header. A missing or
      // dishonest `Content-Length` must not become an unbounded transfer.
      stream: this.toCappedStream(response.body, maxBytes),
    };
  }

  /**
   * The `Referer` value to send upstream, or null when it is unusable.
   *
   * Validated rather than trusted: an absolute `https:` URL with no credentials.
   * It is operator configuration, but a malformed value would be sent to a third
   * party on every poster request, so it is checked before use like any other
   * outbound value.
   */
  private getConfiguredReferer(): string | null {
    const raw = this.configService
      .get<string>("BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_REFERER")
      ?.trim();

    if (raw === undefined || raw === "") {
      return null;
    }

    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "https:") {
        return null;
      }
      if (parsed.username !== "" || parsed.password !== "") {
        return null;
      }

      return parsed.toString();
    } catch {
      return null;
    }
  }

  private readContentLength(response: Response): number | null {
    const raw = response.headers.get("content-length");
    if (raw === null) {
      return null;
    }

    const parsed = Number(raw);

    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  /**
   * Wraps the upstream body so it can never deliver more than `maxBytes`.
   *
   * A CDN that omits `Content-Length`, or reports one and then sends more, must
   * not be able to stream unbounded data through this API. Exceeding the cap
   * destroys the stream with an error, which the route surfaces as the same
   * generic failure as everything else.
   */
  private toCappedStream(
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
  ): NodeJS.ReadableStream {
    const upstream = Readable.fromWeb(
      body as Parameters<typeof Readable.fromWeb>[0],
    );

    /**
     * PULL-BASED, DELIBERATELY. An earlier version attached
     * `upstream.on("data", …)` here, which put the upstream into flowing mode
     * SYNCHRONOUSLY — before the caller had a consumer, and several `await`
     * boundaries before the controller attaches `pipeline()`. Two problems, and
     * the second is the serious one:
     *
     *  1. Bytes were transferred even for a `HEAD`, which reads nothing.
     *  2. An upstream error in that window called `capped.destroy(error)`, and
     *     `Readable.destroy(err)` EMITS `'error'`. With no listener attached
     *     yet, Node treats that as an unhandled `'error'` event and terminates
     *     the process — on an unauthenticated public route.
     *
     * An async generator has neither problem. It pulls nothing until something
     * reads, so a `HEAD` transfers essentially no body; and a `throw` inside it
     * surfaces as an error on the returned stream only when that stream is
     * actually consumed, by which point the consumer owns it.
     */
    // CLAIM `'error'` IMMEDIATELY. `upstream` can fail before anything reads it
    // — a `fetch` body that is already errored, or an edge that resets right
    // after the headers — and a `Readable` that emits `'error'` with no listener
    // terminates the process. Recording it here makes that impossible; the
    // `for await` below still rejects with the same error, because Node's async
    // iterator checks `stream.errored` rather than the listener list, so the
    // consumer is not deprived of it.
    let earlyError: Error | null = null;
    upstream.on("error", (error: Error) => {
      earlyError = error;
    });

    async function* capped(): AsyncGenerator<Buffer> {
      if (earlyError !== null) {
        throw earlyError;
      }

      let seen = 0;
      // `for await` gives backpressure for free.
      for await (const chunk of upstream as AsyncIterable<Buffer>) {
        seen += chunk.length;
        if (seen > maxBytes) {
          // The header was already checked against the cap; reaching here means
          // upstream omitted `Content-Length` or under-reported it. Refuse
          // rather than relay an unbounded body through a public route.
          throw new Error("Bunny poster exceeded the configured size cap.");
        }
        yield chunk;
      }
    }

    const stream = Readable.from(capped());

    // RELEASE THE SOCKET ON EVERY EXIT, including the one where the generator
    // never started. A client `HEAD` destroys this stream without reading a
    // byte, so there is no `for await` to unwind and nothing would otherwise
    // destroy `upstream` — the connection would sit open until the CDN or the
    // fetch timeout gave up. `close` fires for a normal end and for a destroy
    // alike, and destroying an already-ended stream is a no-op.
    stream.once("close", () => {
      upstream.destroy();
    });

    return stream;
  }

  /**
   * Releases an upstream body we are not going to serve.
   *
   * Undrained `fetch` bodies hold a socket open until GC. On a route reachable
   * without authentication that is a slow resource leak, so every rejection
   * path drains explicitly.
   */
  private async discardBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // Nothing useful to do, and nothing depends on it.
    }
  }

  private getMaxBytes(): number {
    return this.readBoundedInteger(
      "BUNNY_PUBLIC_THUMBNAIL_MAX_BYTES",
      DEFAULT_BUNNY_THUMBNAIL_PROXY_MAX_BYTES,
      MIN_BUNNY_THUMBNAIL_PROXY_MAX_BYTES,
      MAX_BUNNY_THUMBNAIL_PROXY_MAX_BYTES,
    );
  }

  private getTimeoutMs(): number {
    return this.readBoundedInteger(
      "BUNNY_PUBLIC_THUMBNAIL_TIMEOUT_MS",
      DEFAULT_BUNNY_THUMBNAIL_PROXY_TIMEOUT_MS,
      MIN_BUNNY_THUMBNAIL_PROXY_TIMEOUT_MS,
      MAX_BUNNY_THUMBNAIL_PROXY_TIMEOUT_MS,
    );
  }

  private readBoundedInteger(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = this.configService.get<string>(key);
    const parsed = Number(raw ?? fallback);

    if (!Number.isInteger(parsed)) {
      return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
  }
}
