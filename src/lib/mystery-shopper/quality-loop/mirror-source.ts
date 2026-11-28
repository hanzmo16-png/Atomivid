import { createHash } from 'node:crypto';
import { publicView, type Queue } from './model';
import { sanitize } from '../v3/detect';

/** Bind a mirror receipt to the completed source, never to a newer CAS revision.
 * Handoff driveId receipts may change without changing this source. Private
 * control metadata affects only the digest, never plaintext report fields;
 * an active inspection is never certifiable. */
export function mirrorSource(q: Queue): string {
  if (q.lease) throw new Error('MIRROR_SOURCE_CHANGED');
  // Cover every retained completion and source field, including corruption that
  // did not emit an event. Only this mirror's own receipts may change its source.
  const source: Record<string, unknown> = Object.fromEntries(Object.entries(q).filter(([key]) => key !== 'mirror'));
  source.defects = q.defects.map(d => Object.fromEntries(Object.entries(d).filter(([key]) => key !== 'driveId')));
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

/** Call inside update's mutation so every CAS retry checks the newest state. */
export function assertMirrorSource(q: Queue, source: string): void {
  if (mirrorSource(q) !== source) throw new Error('MIRROR_SOURCE_CHANGED');
}

export const isMirrorSourceChanged = (error: unknown): boolean =>
  error instanceof Error && error.message === 'MIRROR_SOURCE_CHANGED';

/** Private diagnostic report, never a raw Queue or authority for restoring claims.
 * Explicit DTO fields prevent future Queue additions from leaking capabilities. */
export function mirrorReport(q: Queue, revision: string | null, at: string): string {
  const sourceStamp = mirrorSource(q);
  const secrets = [q.lease?.token, ...q.defects.map(d => d.claim?.token)].filter((v): v is string => typeof v === 'string');
  const diagnosticSecrets = [...secrets, ...q.defects.map(d => d.claim?.actor)].filter((v): v is string => typeof v === 'string');
  const text = (value: string): string => {
    if (typeof value !== 'string') throw new Error('MIRROR_EXPORT_INVALID');
    const clean = sanitize(value, diagnosticSecrets);
    if (clean !== value) throw new Error('MIRROR_EXPORT_SENSITIVE_IDENTITY');
    return value;
  };
  const nullable = (value: string | null | undefined) => value == null ? null : text(value);
  const diagnostic = (value: string) => {
    if (typeof value !== 'string') throw new Error('MIRROR_EXPORT_INVALID');
    return sanitize(value, diagnosticSecrets);
  };
  const count = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('MIRROR_EXPORT_INVALID');
    return value;
  };
  // A public assignment role is not the private claim actor, even when the text
  // happens to coincide. Never allow a capability to hide behind that exception.
  const ownerRole = (value: string) => {
    if (!['codex', 'claude'].includes(value) || sanitize(value, secrets) !== value) throw new Error('MIRROR_EXPORT_INVALID');
    return value;
  };
  const view = publicView(q, at);
  if (q.version !== 'quality-loop/1' || typeof q.enabled !== 'boolean') throw new Error('MIRROR_EXPORT_INVALID');
  return JSON.stringify({
    schema: 'quality-loop-private-report/2', notFullQueueBackup: true,
    redactionPolicy: 'Explicit DTO; no lease, claim, actor, activity or alert metadata; diagnostic text sanitized',
    sourceQueueVersion: q.version, sourceRevision: nullable(revision), sourceStamp, snapshotAt: text(at),
    enabled: q.enabled, updatedAt: text(q.updatedAt), operational: view.operational,
    lastEvaluation: view.lastEvaluation, nextEvaluation: view.nextEvaluation, schedule: view.schedule,
    pending: view.pending, critical: view.critical, fixed: view.fixed, stale: view.stale,
    cycles: q.cycles.map(c => {
      if (c.spendUsd !== 0 || typeof c.authenticated !== 'boolean') throw new Error('MIRROR_EXPORT_INVALID');
      return { id: text(c.id), trigger: text(c.trigger), scope: text(c.scope),
        startedAt: text(c.startedAt), finishedAt: text(c.finishedAt), sha: nullable(c.sha),
        runnerSha: text(c.runnerSha), url: text(c.url), authenticated: c.authenticated,
        sentinel: text(c.sentinel), spendUsd: 0,
        checks: c.checks.map(v => ({ id: text(v.id), product: text(v.product), state: text(v.state),
          severity: text(v.severity), owner: ownerRole(v.owner), module: text(v.module), detail: diagnostic(v.detail) })),
      };
    }),
    defects: q.defects.map(d => ({ id: text(d.id), checkId: text(d.checkId), checkIds: d.checkIds.map(text),
      product: text(d.product), severity: text(d.severity), owner: ownerRole(d.owner), module: text(d.module),
      state: text(d.state), firstSeen: text(d.firstSeen), lastSeen: text(d.lastSeen), occurrences: count(d.occurrences),
      sha: nullable(d.sha), evidence: text(d.evidence), fixSha: nullable(d.fixSha), closedAt: nullable(d.closedAt),
      taskId: text(d.taskId), rootTaskId: nullable(d.rootTaskId), reopens: count(d.reopens ?? 0),
    })),
  }, null, 2);
}
