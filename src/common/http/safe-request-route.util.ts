import type { Request } from "express";

/**
 * Returns a log-safe route TEMPLATE (e.g. `/api/v1/public/watch/:token/videos/
 * :videoId/binary`) — never a raw URL. It reads only Express's matched route
 * pattern (`request.route.path`, which contains `:param` placeholders, not
 * values) optionally prefixed by the static `request.baseUrl`. It deliberately
 * ignores `originalUrl`, `url`, and `path`, all of which can carry query
 * strings and raw route parameters such as share tokens or media grants.
 *
 * Returns `undefined` when no safe template is available (e.g. unmatched
 * routes / 404), so the caller omits the field rather than falling back to a
 * raw URL.
 */
export function safeRequestRoute(request: Request): string | undefined {
  const route = (request as Request & { route?: { path?: unknown } }).route;
  const path = route?.path;
  if (typeof path !== "string" || path.length === 0) {
    return undefined;
  }

  // baseUrl for a global prefix is a static string with no route params.
  const baseUrl = typeof request.baseUrl === "string" ? request.baseUrl : "";
  const combined = `${baseUrl}${path}`;
  return combined.length > 0 ? combined : undefined;
}
