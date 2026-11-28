import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialQueue, claimCycle, type Queue, type Cycle } from './model';
import { mirrorReport, mirrorSource, assertMirrorSource } from './mirror-source';

const AT = '2026-11-28T05:00:00.000Z', SHA = 'a'.repeat(40);
const secret = 'synthetic-capability-unique-not-for-export';
const actor = 'synthetic-private-operator';
function fixture(): Queue {
  const q = initialQueue(AT);
  const c: Cycle = { id: 'schedule-123', trigger: 'schedule', scope: 'authenticated-readonly', startedAt: AT, finishedAt: AT,
    runnerSha: SHA, sha: SHA, url: 'https://github.com/example/repo/actions/runs/123', authenticated: true,
    sentinel: 'READ', spendUsd: 0, checks: [{ id: 'delivery', product: 'reels', state: 'BLOCKED', severity: 'P1', owner: 'codex', module: 'delivery', detail: 'Free egress unverified' }] };
  q.cycles = [c, { ...structuredClone(c), id: 'schedule-124' }];
  q.defects = [{ id: 'd1', checkId: 'delivery', checkIds: ['delivery'], product: 'reels', severity: 'P1', owner: 'codex',
    module: 'delivery', state: 'CLAIMED', firstSeen: AT, lastSeen: AT, occurrences: 2, sha: SHA,
    evidence: c.url, claim: { token: secret, actor, expiresAt: AT }, fixSha: null, closedAt: null, taskId: 'AQL-123', driveId: 'private-drive-id' }];
  q.activity = [{ at: AT, text: `${actor} ${secret}` }]; q.lastAlert = secret;
  return q;
}
function allKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)]);
}
test('legacy raw mirror leaks claim fields; explicit report excludes them without mutating the queue', () => {
  const q = fixture(), before = JSON.stringify(q);
  const legacy = JSON.stringify({ ...q, cycles: q.cycles.slice(-1), activity: q.activity.slice(-30) });
  assert.ok(legacy.includes(secret) && legacy.includes(actor));
  const output = mirrorReport(q, SHA, AT), dto = JSON.parse(output);
  assert.equal(JSON.stringify(q), before);
  for (const forbidden of ['lease', 'claim', 'actor', 'token', 'activity', 'lastAlert', 'driveId']) assert.ok(!allKeys(dto).includes(forbidden));
  assert.ok(!output.includes(secret) && !output.includes(actor) && !output.includes('private-drive-id'));
  assert.equal(dto.schema, 'quality-loop-private-report/2'); assert.equal(dto.notFullQueueBackup, true);
});
test('all retained completions and original negative counts survive, not just the latest cycle', () => {
  const q = fixture(), dto = JSON.parse(mirrorReport(q, SHA, AT));
  assert.deepEqual(dto.cycles, q.cycles); assert.equal(dto.cycles.length, 2);
  for (const c of dto.cycles) {
    const restored = { ...initialQueue(AT), cycles: dto.cycles };
    assert.throws(() => claimCycle(restored, c.id, AT), /ALREADY_COMPLETED/);
    assert.equal(c.checks[0].state, 'BLOCKED');
  }
});
test('unknown queue, defect, cycle and check properties cannot become exported capabilities', () => {
  const q = fixture() as Queue & { surprise?: unknown };
  q.surprise = { credential: secret };
  Object.assign(q.defects[0], { unexpected: { access: secret } });
  Object.assign(q.cycles[0], { unexpected: { access: secret } });
  Object.assign(q.cycles[0].checks[0], { unexpected: { access: secret } });
  assert.ok(!mirrorReport(q, SHA, AT).includes(secret));
});
test('a lease capability is never serialized even by the pure projector; the separate transfer fence still rejects it', () => {
  const q = fixture(); q.lease = { cycleId: 'active', token: 'synthetic-lease-capability', expiresAt: AT };
  const out = mirrorReport(q, SHA, AT); assert.ok(!out.includes('synthetic-lease-capability'));
  assert.throws(() => mirrorSource(q), /MIRROR_SOURCE_CHANGED/);
});
test('capabilities accidentally repeated in diagnostic text are redacted using the existing sanitizer', () => {
  const q = fixture(); q.cycles[0].checks[0].detail = `Unexpected ${secret}`;
  const dto = JSON.parse(mirrorReport(q, SHA, AT));
  assert.equal(dto.cycles[0].checks[0].detail, 'Unexpected [secreto]');
  assert.equal(q.cycles[0].checks[0].detail, `Unexpected ${secret}`);
});
test('service-like bearer credentials and personal emails in diagnostics are sanitized', () => {
  const q = fixture(); q.cycles[0].checks[0].detail = 'Bearer synthetic-secret-token-123456 and private@example.invalid';
  const text = mirrorReport(q, SHA, AT);
  assert.ok(!text.includes('synthetic-secret-token-123456') && !text.includes('private@example.invalid'));
});
test('private claim actors repeated in a diagnostic are redacted without changing the public owner role', () => {
  const q = fixture(); q.cycles[0].checks[0].detail = `Claim actor ${actor}`;
  const dto = JSON.parse(mirrorReport(q, SHA, AT));
  assert.equal(dto.cycles[0].checks[0].detail, 'Claim actor [secreto]');
  assert.equal(dto.defects[0].owner, 'codex');
});
test('a sensitive identity or handoff evidence refuses transfer, rather than silently inventing a new id', () => {
  for (const field of ['id', 'module', 'taskId', 'evidence'] as const) {
    const q = fixture(); q.defects[0][field] = secret;
    assert.throws(() => mirrorReport(q, SHA, AT), /MIRROR_EXPORT_SENSITIVE_IDENTITY/);
  }
});
test('private actors hidden in allowed identity fields are refused, including the source revision', () => {
  for (const field of ['id', 'module', 'taskId', 'evidence'] as const) {
    const q = fixture(); q.defects[0][field] = actor;
    assert.throws(() => mirrorReport(q, SHA, AT), /MIRROR_EXPORT_SENSITIVE_IDENTITY/);
  }
  assert.throws(() => mirrorReport(fixture(), actor, AT), /MIRROR_EXPORT_SENSITIVE_IDENTITY/);
});
test('a public assignment role can coincide with a private actor, but never with a capability', () => {
  const q = fixture(); q.defects[0].claim!.actor = 'codex';
  const dto = JSON.parse(mirrorReport(q, SHA, AT));
  assert.equal(dto.defects[0].owner, 'codex'); assert.ok(!allKeys(dto).includes('claim'));
  q.defects[0].claim!.token = 'codex';
  assert.throws(() => mirrorReport(q, SHA, AT), /MIRROR_EXPORT_INVALID/);
});
test('malformed scalar fields cannot smuggle nested private objects into an allowed DTO field', () => {
  const q = fixture(); Object.assign(q.defects[0], { occurrences: { token: secret } });
  assert.throws(() => mirrorReport(q, SHA, AT), /MIRROR_EXPORT_INVALID/);
  const another = fixture(); Object.assign(another.cycles[0].checks[0], { detail: { token: secret } });
  assert.throws(() => mirrorReport(another, SHA, AT), /MIRROR_EXPORT_INVALID/);
});
test('an unexpected paid amount refuses export under the zero-provider-spend inspection contract', () => {
  const q = fixture(); Object.assign(q.cycles[0], { spendUsd: 1 });
  assert.throws(() => mirrorReport(q, SHA, AT), /MIRROR_EXPORT_INVALID/);
});
test('STOP is reported honestly and does not normalize or activate the source queue', () => {
  const q = fixture(); q.enabled = false; const before = JSON.stringify(q);
  const dto = JSON.parse(mirrorReport(q, null, AT));
  assert.equal(dto.enabled, false); assert.equal(dto.operational, 'STOPPED'); assert.equal(dto.sourceRevision, null);
  assert.equal(JSON.stringify(q), before);
});
test('the original source stamp remains authoritative for concurrent STOP and newer completed cycles', () => {
  const q = fixture(), stamp = mirrorSource(q); mirrorReport(q, SHA, AT); assertMirrorSource(q, stamp);
  q.enabled = false; assert.throws(() => assertMirrorSource(q, stamp), /MIRROR_SOURCE_CHANGED/);
});
test('the actual Drive entrypoint uses the explicit report, retaining its original source fence', () => {
  const script = readFileSync('scripts/mystery-shopper/quality-loop/mirror.ts', 'utf8');
  assert.match(script, /source=mirrorSource\(q\)/);
  assert.match(script, /queueText=mirrorReport\(q,snapshot\.revision,new Date\(\)\.toISOString\(\)\)/);
  assert.doesNotMatch(script, /queueText=JSON\.stringify\(\{\.\.\.q/);
  assert.match(script, /assertMirrorSource\(s,source!\)/);
  assert.ok(script.indexOf('source=mirrorSource(q)') < script.indexOf('queueText=mirrorReport('));
  assert.ok(script.indexOf('queueText=mirrorReport(') < script.indexOf('await channel.createIfAbsent('));
});
