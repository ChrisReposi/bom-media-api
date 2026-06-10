export function normalizeWebsiteDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();

  if (trimmed.length === 0) {
    return null;
  }

  const withoutProtocol = trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^\/+/, "");
  const host = withoutProtocol.split(/[/?#]/)[0]?.replace(/\/+$/, "") ?? "";

  if (host.length === 0 || host.length > 253 || /\s/.test(host)) {
    return null;
  }

  try {
    const parsedUrl = new URL(`http://${host}`);
    return parsedUrl.host.toLowerCase();
  } catch {
    return null;
  }
}
