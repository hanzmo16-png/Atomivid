import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { completedReplayOutcome } from './replay-outcome';
import { initialQueue, type Cycle, type Check } from './model';

const ROOT = process.cwd();
const SHA = 'a'.repeat(40);
const ID = 'manual-730001';
const state = (value: Check['state'], id = 'observed'): Check => ({
  id, product: 'reels', state: value, severity: 'P1', owner: 'codex', module: 'delivery', detail: 'Offline fixture only',
});
function cycle(checks: Check[] = [state('PASS')]): Cycle {
  return { id: ID, trigger: 'workflow_dispatch', scope: 'authenticated-readonly',
    startedAt: '2026-11-27T00:00:00.000Z', finishedAt: '2026-11-27T00:00:01.000Z',
    runnerSha: SHA, sha: SHA, url: 'https://github.com/hanzmo16-png/Atomivid/actions/runs/730001',
    authenticated: true, sentinel: 'READ', checks, spendUsd: 0 };
}
function queue(cycles: unknown[]) {
  return { ...initialQueue('2026-11-27T00:00:01.000Z'), cycles };
}

// This preload is a transport fixture, not a runner replacement. The actual run.ts
// and GitHubQueueStore execute in the child. Every non-queue GET and every write fail.
const PRELOAD = `
import {readFileSync,appendFileSync} from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const denySpawn=()=>{
 appendFileSync(process.env.AQL_OFFLINE_TRACE,JSON.stringify({method:'SPAWN',target:'FORBIDDEN'})+'\\n');
 throw Error('OFFLINE_SPAWN_FORBIDDEN');
};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=denySpawn;
syncBuiltinESMExports();
const fixture=JSON.parse(readFileSync(process.env.AQL_OFFLINE_INPUT,'utf8'));
const allowed='https://api.github.com/repos/hanzmo16-png/Atomivid/contents/state.json?ref=automation/quality-loop-state';
let index=0;
globalThis.fetch=async(input,init={})=>{
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 const method=(init.method||'GET').toUpperCase();
 const safe=method==='GET'&&url===allowed;
 appendFileSync(process.env.AQL_OFFLINE_TRACE,JSON.stringify({method,target:safe?'QUEUE_GET':'FORBIDDEN'})+'\\n');
 if(!safe)throw Error('OFFLINE_FETCH_FORBIDDEN');
 const data=fixture.responses[Math.min(index++,fixture.responses.length-1)];
 return Response.json({sha:'f'.repeat(40),content:Buffer.from(JSON.stringify(data)).toString('base64')});
};
`;

async function run(responses: unknown[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aql-replay-offline-'));
  try {
    const input = path.join(dir, 'fixture.json'), trace = path.join(dir, 'trace.jsonl'), out = path.join(dir, 'out');
    const bytes = JSON.stringify({ responses });
    const preload = path.join(dir, 'fetch-preload.mjs');
    await writeFile(input, bytes); await writeFile(preload, PRELOAD);
    const result = spawnSync(process.execPath, ['--import', preload, '--import', 'tsx', path.join(ROOT, 'scripts/mystery-shopper/quality-loop/run.ts')], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000, maxBuffer: 1_048_576,
      // No inherited provider keys, QA session, OIDC, real GitHub token or NODE_OPTIONS.
      env: { PATH: process.env.PATH || '', NODE_ENV: 'test', GITHUB_TOKEN: 'offline-fixture-token', GITHUB_REPOSITORY: 'hanzmo16-png/Atomivid',
        GITHUB_RUN_ID: '730001', GITHUB_SHA: SHA, RUNNER_OS: 'Linux', AQL_TRIGGER: 'workflow_dispatch',
        MYSTERY_SHOPPER_AUTO: '1', AQL_PUBLIC_REPO: 'true', MS_OUT_DIR: out,
        AQL_OFFLINE_INPUT: input, AQL_OFFLINE_TRACE: trace },
    });
    assert.equal(result.error, undefined, 'the real runner must complete within the offline deadline');
    assert.equal(result.signal, null);
    assert.equal(await readFile(input, 'utf8'), bytes, 'persisted fixture queue must remain byte-identical');
    const requests = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {method:string;target:string});
    assert.ok(requests.length >= 1);
    assert.ok(requests.every(r => r.method === 'GET' && r.target === 'QUEUE_GET'), 'no queue writes, alerts, browser, provider or storage requests');
    const files = await readdir(out);
    assert.ok(!files.includes('cycle.json') && !files.includes('summary.json'), 'replay never publishes a new evaluation');
    const skipped = files.includes('skipped.json') ? JSON.parse(await readFile(path.join(out, 'skipped.json'), 'utf8')) : null;
    assert.doesNotMatch(result.stderr, /RUNNER_UNAVAILABLE|OFFLINE_FETCH_FORBIDDEN|OFFLINE_SPAWN_FORBIDDEN/);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, skipped, requests };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('completed BLOCKED replay preserves exit1 without revalidation or writes', async () => {
  const result = await run([queue([cycle([state('BLOCKED')])])]);
  assert.equal(result.status, 1);
  assert.equal(result.skipped?.state, 'ALREADY_COMPLETED');
  assert.equal(result.skipped?.validation, 'NO_REVALIDATION');
  assert.equal(result.skipped?.originalOutcome.exitCode, 1);
  assert.equal(result.skipped?.originalOutcome.basis, 'PERSISTED_CHECK_STATES');
  assert.equal(result.skipped?.originalOutcome.counts.BLOCKED, 1);
  assert.match(result.stdout, /^ALREADY_COMPLETED: NO_REVALIDATION; original cycle exit 1$/m);
  assert.equal(result.requests.length, 1);
});

test('completed FAIL replay preserves exit1 and the original check counts', async () => {
  const result = await run([queue([cycle([state('FAIL'), state('BLOCKED', 'blocked')])])]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.skipped?.originalOutcome.counts, { PASS: 0, FAIL: 1, BLOCKED: 1, SKIP: 0 });
  assert.equal(result.skipped?.state, 'ALREADY_COMPLETED');
  assert.equal(result.skipped?.validation, 'NO_REVALIDATION');
  assert.match(result.stdout, /^ALREADY_COMPLETED: NO_REVALIDATION; original cycle exit 1$/m);
  assert.equal(result.requests.length, 1);
});

test('the same check ID across different products is not a duplicate or a new observation', async () => {
  const checks = (['youtube', 'reels', 'audio-podcast', 'video-podcast'] as const)
    .map(product => ({ ...state('BLOCKED', 'provider-readiness'), product }));
  const result = await run([queue([cycle(checks)])]);
  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 1);
  assert.equal(result.skipped?.validation, 'NO_REVALIDATION');
  assert.deepEqual(result.skipped?.originalOutcome.counts, { PASS: 0, FAIL: 0, BLOCKED: 4, SKIP: 0 });
  assert.match(result.stdout, /^ALREADY_COMPLETED: NO_REVALIDATION; original cycle exit 1$/m);
});

for (const checks of [[state('PASS'), state('SKIP', 'not-applicable')], [state('SKIP')]]) {
  test(`valid historical ${checks.map(c=>c.state).join('/')} replay retains exit0 but never claims new evidence`, async () => {
    const result = await run([queue([cycle(checks)])]);
    assert.equal(result.status, 0);
    assert.equal(result.skipped?.validation, 'NO_REVALIDATION');
    assert.equal(result.skipped?.originalOutcome.exitCode, 0);
    assert.equal(result.skipped?.originalOutcome.finishedAt, '2026-11-27T00:00:01.000Z');
    assert.equal(result.skipped?.state, 'ALREADY_COMPLETED');
    assert.match(result.stdout, /^ALREADY_COMPLETED: NO_REVALIDATION; original cycle exit 0$/m);
    assert.equal(result.requests.length, 1);
  });
}

test('a historical fixture remains explicitly a fixture, never new authenticated production evidence', async () => {
  const historical = { ...cycle([state('SKIP')]), scope: 'fixture', authenticated: false, sha: null, sentinel: 'BLOCKED' };
  const result = await run([queue([historical])]);
  assert.equal(result.status, 0);
  assert.equal(result.skipped?.validation, 'NO_REVALIDATION');
  assert.equal(result.skipped?.originalOutcome.scope, 'fixture');
  assert.equal(result.skipped?.originalOutcome.authenticated, false);
  assert.equal(result.skipped?.originalOutcome.applicationSha, null);
  assert.equal(result.skipped?.originalOutcome.basis, 'PERSISTED_CHECK_STATES');
  assert.equal(result.requests.length, 1);
  assert.match(result.stdout, /^ALREADY_COMPLETED: NO_REVALIDATION; original cycle exit 0$/m);
});

test('missing persisted completion fails closed in the outcome validator', () => {
  assert.throws(() => completedReplayOutcome([], ID, 'workflow_dispatch', '2026-11-28T00:00:00Z'), /COMPLETED_REPLAY_MISSING/);
});

test('replay preserves the original BLOCKED snapshot even if a subsequent read would return PASS', async () => {
  const result = await run([queue([cycle([state('BLOCKED')])]), queue([cycle()])]);
  assert.equal(result.status, 1);
  assert.equal(result.skipped?.state, 'ALREADY_COMPLETED');
  assert.equal(result.skipped?.validation, 'NO_REVALIDATION');
  assert.equal(result.skipped?.originalOutcome.counts.BLOCKED, 1);
  assert.match(result.stdout, /^ALREADY_COMPLETED: NO_REVALIDATION; original cycle exit 1$/m);
  assert.equal(result.requests.length, 1);
});

test('duplicate completed records fail closed instead of selecting a convenient result', async () => {
  const result = await run([queue([cycle(), cycle([state('BLOCKED')])])]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /COMPLETED_REPLAY_DUPLICATE/);
  assert.equal(result.requests.length, 1);
});

const malformed = [
  { checks: [] }, { checks: null }, { checks: [state('PASS'), state('PASS')] },
  { checks: [{ ...state('PASS'), state: 'UNKNOWN' }] },
  { checks: [{ ...state('PASS'), severity: 'P9' }] },
  { checks: [{ ...state('PASS'), product: 'unknown-product' }] },
  { checks: [{ ...state('PASS'), owner: 'unknown-owner' }] },
  { checks: [{ ...state('PASS'), detail: null }] },
  { checks: [{ ...state('PASS'), state: ['PASS'] }] },
  { checks: [{ ...state('PASS'), severity: ['P1'] }] },
  { checks: [{ ...state('PASS'), owner: ['codex'] }] },
  { finishedAt: '' }, { finishedAt: '2026-11-26T00:00:00Z' }, { finishedAt: '2099-01-01T00:00:00Z' },
  { startedAt: '0' }, { finishedAt: '2026-02-30T00:00:00.000Z' },
  { runnerSha: 'invalid' }, { sha: 'invalid' }, { authenticated: 'true' }, { sentinel: 'READY' },
  { spendUsd: 1 }, { trigger: 'schedule' }, { scope: 'native' },
  { scope: ['fixture'] }, { sentinel: ['READ'] },
];
for (const [index, patch] of malformed.entries()) {
  test(`malformed persisted completion ${index + 1} fails closed without mutating history`, async () => {
    const result = await run([queue([{ ...cycle(), ...patch }])]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /COMPLETED_REPLAY_INVALID/);
    assert.equal(result.requests.length, 1);
  });
}

test('STOP preserves its existing control and never replays or writes', async () => {
  const result = await run([{ ...queue([cycle([state('BLOCKED')])]), enabled: false }]);
  assert.equal(result.status, 0);
  assert.equal(result.skipped?.state, 'STOPPED');
  assert.equal(result.requests.length, 1);
});

test('a held lease preserves its existing control and performs no inspection', async () => {
  const result = await run([{ ...queue([]), lease: { cycleId: 'manual-other', token: 'offline-lease', expiresAt: '2099-01-01T00:00:00Z' } }]);
  assert.equal(result.status, 0);
  assert.equal(result.skipped?.state, 'LEASE_HELD');
  assert.equal(result.requests.length, 1);
});
