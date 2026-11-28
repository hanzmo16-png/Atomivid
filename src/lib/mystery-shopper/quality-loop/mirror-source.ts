import { createHash } from 'node:crypto';
import type { Queue } from './model';

/** Bind a mirror receipt to the completed source, never to a newer CAS revision.
 * Handoff driveId receipts may change without changing this source. No token is
 * included in the stamp, and an active inspection is never certifiable. */
export function mirrorSource(q: Queue): string {
  if (q.lease) throw new Error('MIRROR_SOURCE_CHANGED');
  return createHash('sha256').update(JSON.stringify({
    enabled: q.enabled, updatedAt: q.updatedAt, cycle: q.cycles.at(-1) ?? null,
    activity: q.activity, lastAlert: q.lastAlert,
  })).digest('hex');
}

/** Call inside update's mutation so every CAS retry checks the newest state. */
export function assertMirrorSource(q: Queue, source: string): void {
  if (mirrorSource(q) !== source) throw new Error('MIRROR_SOURCE_CHANGED');
}

export const isMirrorSourceChanged = (error: unknown): boolean =>
  error instanceof Error && error.message === 'MIRROR_SOURCE_CHANGED';
