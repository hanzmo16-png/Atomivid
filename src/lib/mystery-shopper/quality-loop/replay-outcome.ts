/** Historical replay preserves a completed cycle's check result; it never revalidates it. */
import { PRODUCTS, type Cycle } from './model';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const products = new Set<string>([...PRODUCTS, 'account-nav', 'commercial', 'command-center']);
function timestamp(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return NaN;
  const parsed = Date.parse(value), normalized = `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalized ? parsed : NaN;
}

export function completedReplayOutcome(cycles: unknown, id: string, trigger: Cycle['trigger'], replayedAt: string) {
  if (!Array.isArray(cycles)) throw new Error('COMPLETED_REPLAY_INVALID');
  const matches = cycles.filter(cycle => object(cycle) && cycle.id === id);
  if (!matches.length) throw new Error('COMPLETED_REPLAY_MISSING');
  if (matches.length !== 1) throw new Error('COMPLETED_REPLAY_DUPLICATE');
  const cycle = matches[0] as Record<string, unknown>;
  const started = timestamp(cycle.startedAt), finished = timestamp(cycle.finishedAt), at = timestamp(replayedAt);
  if (cycle.trigger !== trigger || typeof cycle.scope !== 'string' || !['authenticated-readonly', 'fixture'].includes(cycle.scope)
    || !Number.isFinite(started) || !Number.isFinite(finished) || !Number.isFinite(at) || finished < started || finished > at
    || !sha(cycle.runnerSha) || (cycle.sha !== null && !sha(cycle.sha)) || typeof cycle.authenticated !== 'boolean'
    || typeof cycle.sentinel !== 'string' || !['READ', 'BLOCKED'].includes(cycle.sentinel) || cycle.spendUsd !== 0
    || typeof cycle.url !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(cycle.url)
    || !Array.isArray(cycle.checks) || !cycle.checks.length) throw new Error('COMPLETED_REPLAY_INVALID');

  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, SKIP: 0 };
  const seen = new Set<string>();
  for (const check of cycle.checks) {
    if (!object(check) || !text(check.id) || typeof check.product !== 'string' || !products.has(check.product)
      || typeof check.state !== 'string' || !['PASS', 'FAIL', 'BLOCKED', 'SKIP'].includes(check.state)
      || typeof check.severity !== 'string' || !['P0', 'P1', 'P2', 'P3'].includes(check.severity)
      || typeof check.owner !== 'string' || !['codex', 'claude'].includes(check.owner) || !text(check.module) || typeof check.detail !== 'string')
      throw new Error('COMPLETED_REPLAY_INVALID');
    const key = `${check.product}|${check.id}`;
    if (seen.has(key)) throw new Error('COMPLETED_REPLAY_INVALID');
    seen.add(key); counts[check.state as keyof typeof counts]++;
  }
  return {
    basis: 'PERSISTED_CHECK_STATES' as const,
    exitCode: counts.FAIL || counts.BLOCKED ? 1 as const : 0 as const,
    counts, finishedAt: cycle.finishedAt as string,
    applicationSha: cycle.sha as string | null, runnerSha: cycle.runnerSha,
    scope: cycle.scope as Cycle['scope'], authenticated: cycle.authenticated,
  };
}
