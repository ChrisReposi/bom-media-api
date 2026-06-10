import { createHash } from "node:crypto";

export function hashShareToken(params: {
  token: string;
  pepper: string;
}): string {
  return createHash("sha256")
    .update(`${params.pepper}${params.token}`, "utf8")
    .digest("hex");
}
