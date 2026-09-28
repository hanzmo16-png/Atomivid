/**
 * A quoted project is pinned to exact policy/profile/contract/rate-card/memory versions.
 * Nothing a project does mid-production can swap them (invariant 20).
 */
export type ProjectPin = {
  projectId: string;
  policyVersion: string;
  profileVersion: string;
  contractVersion: string;
  rateCardVersion: string;
  memorySnapshotId: string;
  pinnedAt: string;
};

export class SnapshotMismatchError extends Error {}

export function pinProject(p: Omit<ProjectPin, "pinnedAt">, pinnedAt: string): Readonly<ProjectPin> {
  return Object.freeze({ ...p, pinnedAt });
}

export function assertPinned(pin: ProjectPin, used: Omit<ProjectPin, "projectId" | "pinnedAt">): void {
  for (const k of Object.keys(used) as (keyof typeof used)[]) {
    if (pin[k] !== used[k]) throw new SnapshotMismatchError(`Project ${pin.projectId} is pinned to ${k}=${pin[k]}, got ${used[k]}`);
  }
}
