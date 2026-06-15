import { SetMetadata } from "@nestjs/common";

export const THROTTLE_PROFILE_METADATA = "bom:throttle-profile";

export const THROTTLE_PROFILES = {
  login: "login",
  refresh: "refresh",
  logout: "logout",
  admin: "admin",
  publicWatch: "publicWatch",
  publicMedia: "publicMedia",
} as const;

export type ThrottleProfile =
  (typeof THROTTLE_PROFILES)[keyof typeof THROTTLE_PROFILES];

export function ThrottleProfile(profile: ThrottleProfile) {
  return SetMetadata(THROTTLE_PROFILE_METADATA, profile);
}
