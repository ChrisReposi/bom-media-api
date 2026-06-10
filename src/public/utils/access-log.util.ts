import { createHash } from "node:crypto";

export function hashIpAddress(params: {
  ip: string | undefined;
  pepper: string | undefined;
}): string | null {
  const ip = params.ip?.trim();
  const pepper = params.pepper?.trim();

  if (!ip || !pepper) {
    return null;
  }

  return createHash("sha256").update(`${pepper}${ip}`, "utf8").digest("hex");
}

export function truncateAccessLogValue(
  value: string | undefined,
  maxLength: number,
): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, maxLength);
}

export function truncateDomain(value: string | null): string | null {
  return value === null ? null : truncateAccessLogValue(value, 253);
}

export function truncateReasonCode(value: string): string {
  return value.trim().slice(0, 80);
}
