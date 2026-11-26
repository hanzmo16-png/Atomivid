/** Persistent orchestration for Mystery Shopper. No provider calls or production writes. */
import { createHash, randomUUID } from 'node:crypto';
import { sanitize, type Severity } from '../v3/detect';
export const PRODUCTS = ['youtube', 'reels', 'audio-podcast', 'video-podcast'] as const;
export type Product = typeof PRODUCTS[number];
export type Check = { id: string; product: Product | 'account-nav' | 'commercial' | 'command-center'; state: 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIP'; severity: Severity; owner: 'codex' | 'claude'; module: string; detail: string };
export type Cycle = { id: string; trigger: 'schedule' | 'deployment_status' | 'workflow_dispatch' | 'fixture'; scope: 'authenticated-readonly' | 'fixture'; startedAt: string; finishedAt: string; sha: string | null; runnerSha: string; url: string; authenticated: boolean; sentinel: 'READ' | 'BLOCKED'; checks: Check[]; spendUsd: 0 };
export type Defect = { id: string; checkId: string; checkIds: string[]; product: Check['product']; severity: Severity; owner: Check['owner']; module: string; state: 'DETECTED' | 'CLAIMED' | 'FIXED_IN_BRANCH' | 'INTEGRATED' | 'REVALIDATED'; firstSeen: string; lastSeen: string; occurrences: number; sha: string | null; evidence: string; claim: { token: string; actor: string; expiresAt: string } | null; fixSha: string | null; closedAt: string | null; taskId: string; driveId: string | null };
export type Queue = { version: 'quality-loop/1'; enabled: boolean; updatedAt: string; lease: { cycleId: string; token: string; expiresAt: string } | null; cycles: Cycle[]; defects: Defect[]; activity: { at: string; text: string }[]; lastAlert: string | null; mirror: { at: string | null; state: 'PENDING' | 'VERIFIED' | 'BLOCKED' } };
export const initialQueue = (at: string): Queue => ({ version: 'quality-loop/1', enabled: true, updatedAt: at, lease: null, cycles: [], defects: [], activity: [], lastAlert: null, mirror: { at: null, state: 'PENDING' } });
export const fingerprint = (c: Pick<Check, 'id' | 'product'>) => createHash('sha256').update(`${c.product}|${c.id.replace(/-(390|412|1366|1440)$/, '')}`).digest('hex').slice(0, 24);
export function event(q: Queue, at: string, text: string) { q.updatedAt = at; q.activity = [...q.activity, { at, text: sanitize(text) }].slice(-200); q.mirror.state = 'PENDING'; }
export function claimCycle(q: Queue, cycleId: string, at: string): string {
  if (!q.enabled) throw new Error('STOPPED');
  if (q.cycles.some(c => c.id === cycleId)) throw new Error('ALREADY_COMPLETED');
  if (q.lease && Date.parse(q.lease.expiresAt) > Date.parse(at)) throw new Error('LEASE_HELD');
  const token = randomUUID(); q.lease = { cycleId, token, expiresAt: new Date(Date.parse(at) + 20 * 60000).toISOString() };
  event(q, at, `Cycle ${cycleId} claimed`); return token;
}
export function finishCycle(q: Queue, cycle: Cycle, token: string) {
  if (!q.enabled) throw new Error('STOPPED');
  if (!q.lease || q.lease.token !== token || q.lease.cycleId !== cycle.id || Date.parse(q.lease.expiresAt) <= Date.parse(cycle.finishedAt)) throw new Error('FENCED_OR_EXPIRED');
  if (cycle.spendUsd !== 0 || !/^[a-f0-9]{40}$/.test(cycle.runnerSha) || (cycle.sha !== null && !/^[a-f0-9]{40}$/.test(cycle.sha))) throw new Error('INVALID_CYCLE');
  if (new Set(cycle.checks.map(c => `${c.product}|${c.id}`)).size !== cycle.checks.length) throw new Error('DUPLICATE_CHECK');
  // Fixtures are preserved separately and NEVER close real defects.
  const grouped=new Map<string,Check[]>();
  for(const c of cycle.checks){const key=fingerprint(c);grouped.set(key,[...(grouped.get(key)||[]),c]);}
  if (cycle.scope !== 'fixture') for (const [id,related] of grouped) {
    const c=related.find(c=>c.state==='FAIL')||related.find(c=>c.state==='BLOCKED')||related[0]; let d = q.defects.find(d => d.id === id);
    if (c.state === 'FAIL') {
      if (!d) {
        if (q.defects.length >= 1000) throw new Error('QUEUE_CAPACITY_REQUIRES_ARCHIVE');
        const dt = cycle.startedAt.replace(/[-:]/g, '');
        d = { id, checkId: c.id.replace(/-(390|412|1366|1440)$/, ''), checkIds: related.map(c=>c.id), product: c.product, severity: c.severity, owner: c.owner, module: c.module, state: 'DETECTED', firstSeen: cycle.finishedAt, lastSeen: cycle.finishedAt, occurrences: 0, sha: cycle.sha, evidence: cycle.url, claim: null, fixSha: null, closedAt: null, taskId: `T-${dt.slice(0,8)}-${dt.slice(9,13)}-orquestador-${String(parseInt(id.slice(0,8),16)).padStart(2,'0')}`, driveId: null };
        q.defects.push(d);
      }
      d.occurrences++; d.lastSeen = cycle.finishedAt; d.sha = cycle.sha; d.evidence = cycle.url; d.severity = [...related].sort((a,b)=>a.severity.localeCompare(b.severity))[0].severity; d.checkIds=[...new Set([...(d.checkIds||[d.checkId]),...related.map(c=>c.id)])];
      if (d.state === 'REVALIDATED') { d.state = 'DETECTED'; d.claim = null; d.fixSha = null; d.closedAt = null; event(q, cycle.finishedAt, `Reopened ${id}`); }
    } else if (related.every(c=>c.state==='PASS') && d && (d.checkIds||[d.checkId]).every(id=>related.some(c=>c.id===id)) && d?.state === 'INTEGRATED' && cycle.authenticated && cycle.sha === d.fixSha && !cycle.checks.some(c=>c.id.startsWith('deployment-sha')&&c.state!=='PASS')) {
      d.state = 'REVALIDATED'; d.closedAt = cycle.finishedAt; d.claim = null;
      event(q, cycle.finishedAt, `Revalidated ${id} on ${cycle.sha}`);
    }
  }
  q.cycles = [...q.cycles, cycle].slice(-96); q.lease = null; event(q, cycle.finishedAt, `Completed ${cycle.id}`);
}
export function claimDefect(q: Queue, id: string, owner: 'codex' | 'claude', actor: string, at: string): string {
  if(!q.enabled)throw new Error('STOPPED');
  const d = q.defects.find(d => d.id === id); if (!d || d.owner !== owner || d.state === 'REVALIDATED') throw new Error('NOT_CLAIMABLE');
  if (d.claim && Date.parse(d.claim.expiresAt) > Date.parse(at)) throw new Error('ALREADY_CLAIMED');
  if (q.defects.some(other => other.id !== id && other.module === d.module && other.claim && Date.parse(other.claim.expiresAt) > Date.parse(at))) throw new Error('MODULE_ALREADY_CLAIMED');
  const token = randomUUID(); d.claim = { token, actor: sanitize(actor), expiresAt: new Date(Date.parse(at) + 2 * 3600000).toISOString() }; d.state = 'CLAIMED'; event(q, at, `Claim ${id} assigned to ${owner}; actor ${sanitize(actor)}`); return token;
}
export function transition(q: Queue, id: string, token: string, next: 'FIXED_IN_BRANCH' | 'INTEGRATED', sha: string, at: string) {
  const d = q.defects.find(d => d.id === id);
  if (!d?.claim || d.claim.token !== token || Date.parse(d.claim.expiresAt) <= Date.parse(at) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('INVALID_CLAIM_OR_SHA');
  if ((next === 'FIXED_IN_BRANCH' && d.state !== 'CLAIMED') || (next === 'INTEGRATED' && d.state !== 'FIXED_IN_BRANCH')) throw new Error('INVALID_TRANSITION');
  d.state = next; d.fixSha = sha; event(q, at, `${id} ${next}`);
}
export function publicView(q: Queue, now: string) {
  const last = [...q.cycles].reverse().find(c => c.scope !== 'fixture');
  const pending = q.defects.filter(d => d.state !== 'REVALIDATED');
  const operational = !q.enabled ? 'STOPPED' : !last || Date.parse(now)-Date.parse(last.finishedAt)>75*60000 ? 'STALE' : last.checks.some(c=>c.state==='FAIL') ? 'ERROR' : last.checks.some(c=>c.state==='BLOCKED') ? 'BLOCKED' : 'ACTIVE';
  return { ...q, operational, lease: q.lease ? { cycleId: q.lease.cycleId, expiresAt: q.lease.expiresAt } : null, defects: q.defects.map(d => ({ ...d, claim: d.claim ? { actor: d.claim.actor, expiresAt: d.claim.expiresAt } : null })), lastEvaluation: last?.finishedAt ?? null, nextEvaluation: q.enabled ? new Date(Math.floor((Date.parse(now)-17*60000)/1800000)*1800000+47*60000).toISOString() : null, schedule: 'GitHub cron best effort; next time is nominal, not guaranteed', pending: pending.length, critical: pending.filter(d => d.severity === 'P0').length, fixed: q.defects.length-pending.length, stale: !last || Date.parse(now)-Date.parse(last.finishedAt)>75*60000 };
}
