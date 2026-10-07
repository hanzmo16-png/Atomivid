/**
 * YouTube capabilities and their minimum OAuth scopes. V1 enables READ only.
 * Upload is implemented behind a flag that defaults to OFF; schedule/publish are OFF.
 */
export const CAPABILITIES = ["READ_CHANNEL", "READ_ANALYTICS", "UPLOAD_PRIVATE", "SCHEDULE", "PUBLISH"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Official Google scopes (least privilege per capability). */
export const SCOPES: Record<Capability, string[]> = {
  READ_CHANNEL: ["https://www.googleapis.com/auth/youtube.readonly"],
  READ_ANALYTICS: ["https://www.googleapis.com/auth/yt-analytics.readonly"],
  UPLOAD_PRIVATE: ["https://www.googleapis.com/auth/youtube.upload"],
  SCHEDULE: ["https://www.googleapis.com/auth/youtube.upload"],
  PUBLISH: ["https://www.googleapis.com/auth/youtube.upload"],
};

export type DistributionFlags = { enabled: Capability[]; AUTO_PUBLISH: false };

/**
 * V1 flags. AUTO_PUBLISH is typed as the literal `false`: turning it on requires a
 * code change and review, never an env toggle. UPLOAD_PRIVATE can be added to
 * `enabled` only via YOUTUBE_UPLOAD_PRIVATE_ENABLED=true (default off).
 */
export function distributionFlags(env: Record<string, string | undefined> = process.env): DistributionFlags {
  const enabled: Capability[] = ["READ_CHANNEL", "READ_ANALYTICS"];
  if (env.YOUTUBE_UPLOAD_PRIVATE_ENABLED === "true") enabled.push("UPLOAD_PRIVATE");
  return { enabled, AUTO_PUBLISH: false };
}

export function scopesFor(caps: Capability[]): string[] {
  return [...new Set(caps.flatMap((c) => SCOPES[c]))].sort();
}

export class CapabilityDisabledError extends Error {}

export function assertCapability(flags: DistributionFlags, c: Capability): void {
  if (c === "PUBLISH" || c === "SCHEDULE") throw new CapabilityDisabledError(`${c} is disabled in V1 (AUTO_PUBLISH=false): the user publishes manually`);
  if (!flags.enabled.includes(c)) throw new CapabilityDisabledError(`${c} is not enabled`);
}
