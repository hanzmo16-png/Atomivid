import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expectedCycleId, shouldAlertInterruption } from './interruption-alert.mjs';

const id = 'deployment-123-' + 'a'.repeat(40);
const receipt = () => ({ id, state: 'ALREADY_COMPLETED', validation: 'NO_REVALIDATION', spendUsd: 0,
  originalOutcome: { basis: 'PERSISTED_CHECK_STATES', exitCode: 1, counts: { PASS: 56, FAIL: 0, BLOCKED: 21, SKIP: 12 } } });
async function fixture(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aql-alert-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('expected cycle is bound to the original event, not the current queue', () => {
  assert.equal(expectedCycleId({ AQL_TRIGGER: 'schedule', GITHUB_RUN_ID: '7' }), 'schedule-7');
  assert.equal(expectedCycleId({ AQL_TRIGGER: 'workflow_dispatch', GITHUB_RUN_ID: '7' }), 'manual-7');
  assert.equal(expectedCycleId({ AQL_TRIGGER: 'deployment_status', GITHUB_RUN_ID: '7', AQL_DEPLOYMENT_ID: '123', AQL_EXPECTED_SHA: 'a'.repeat(40) }), id);
  for (const env of [{}, { AQL_TRIGGER: 'schedule', GITHUB_RUN_ID: 'bad' }, { AQL_TRIGGER: 'deployment_status', GITHUB_RUN_ID: '7' }, { AQL_TRIGGER: 'unknown', GITHUB_RUN_ID: '7' }]) assert.equal(expectedCycleId(env), null);
});
test('missing output, missing/corrupt replay and directory masquerading as cycle still alert', async () => fixture(async dir => {
  assert.equal(await shouldAlertInterruption(null, id), true);
  assert.equal(await shouldAlertInterruption(dir, null), true);
  assert.equal(await shouldAlertInterruption(dir, id), true);
  await mkdir(path.join(dir, 'cycle.json'));
  await writeFile(path.join(dir, 'skipped.json'), 'partial JSON');
  assert.equal(await shouldAlertInterruption(dir, id), true);
}));
test('existing completed observation does not acquire a second interruption alert', async () => fixture(async dir => {
  await writeFile(path.join(dir, 'cycle.json'), JSON.stringify({ id }));
  assert.equal(await shouldAlertInterruption(dir, id), false);
}));
test('negative BLOCKED replay suppresses only interruption alert', async () => fixture(async dir => {
  await writeFile(path.join(dir, 'skipped.json'), JSON.stringify(receipt()));
  assert.equal(await shouldAlertInterruption(dir, id), false);
}));
test('negative FAIL replay suppresses only interruption alert', async () => fixture(async dir => {
  const r = receipt(); r.originalOutcome.counts.BLOCKED = 0; r.originalOutcome.counts.FAIL = 1;
  await writeFile(path.join(dir, 'skipped.json'), JSON.stringify(r));
  assert.equal(await shouldAlertInterruption(dir, id), false);
}));
for (const [name, change] of [
  ['different cycle', r => { r.id = 'manual-999'; }],
  ['missing NO_REVALIDATION', r => { delete r.validation; }],
  ['STOPPED', r => { r.state = 'STOPPED'; }],
  ['LEASE_HELD', r => { r.state = 'LEASE_HELD'; }],
  ['nonzero spend', r => { r.spendUsd = 1; }],
  ['untrusted result basis', r => { r.originalOutcome.basis = 'NEW_EXECUTION'; }],
  ['zero exit despite blocks', r => { r.originalOutcome.exitCode = 0; }],
  ['all PASS cannot explain a failure', r => { r.originalOutcome.counts.BLOCKED = 0; }],
  ['negative count', r => { r.originalOutcome.counts.PASS = -1; }],
  ['fractional count', r => { r.originalOutcome.counts.FAIL = 0.5; }],
  ['string count', r => { r.originalOutcome.counts.BLOCKED = '21'; }],
  ['missing counts', r => { delete r.originalOutcome.counts; }],
]) test(`${name}: interruption still alerts`, async () => fixture(async dir => {
  const r = receipt(); change(r); await writeFile(path.join(dir, 'skipped.json'), JSON.stringify(r));
  assert.equal(await shouldAlertInterruption(dir, id), true);
}));

test('actual failure-step shell never calls alert executable for a negative replay; job remains failed', async () => fixture(async dir => {
  const executable = fileURLToPath(new URL('./interruption-alert.mjs', import.meta.url));
  await writeFile(path.join(dir, 'skipped.json'), JSON.stringify(receipt()));
  const env = { PATH: process.env.PATH, OUT: dir, AQL_TRIGGER: 'deployment_status', GITHUB_RUN_ID: '7', AQL_DEPLOYMENT_ID: '123', AQL_EXPECTED_SHA: 'a'.repeat(40), NODE: process.execPath, CLASSIFIER: executable };
  const shell = 'alert_status=0; "$NODE" "$CLASSIFIER" || alert_status=$?; if [[ "$alert_status" != 10 ]]; then printf ALERT_SENT >> "$OUT/alerts"; fi; exit 1';
  const oldShell = 'if [[ ! -f "$OUT/cycle.json" ]]; then printf FALSE_INTERRUPTION >> "$OUT/old-alerts"; fi; exit 1';
  const before = spawnSync('/bin/bash', ['-c', oldShell], { env, encoding: 'utf8' });
  assert.equal(before.status, 1);
  assert.equal(await readFile(path.join(dir, 'old-alerts'), 'utf8'), 'FALSE_INTERRUPTION');
  const replay = spawnSync('/bin/bash', ['-c', shell], { env, encoding: 'utf8' });
  assert.equal(replay.status, 1); assert.match(replay.stdout, /NO_INTERRUPTION_ALERT/);
  await assert.rejects(readFile(path.join(dir, 'alerts')), { code: 'ENOENT' });
  await writeFile(path.join(dir, 'skipped.json'), '{}');
  const broken = spawnSync('/bin/bash', ['-c', shell], { env, encoding: 'utf8' });
  assert.equal(broken.status, 1); assert.match(broken.stdout, /INTERRUPTION_ALERT_REQUIRED/);
  assert.equal(await readFile(path.join(dir, 'alerts'), 'utf8'), 'ALERT_SENT');
}));
test('missing or broken classifier still emits an interruption alert and preserves job failure', async () => fixture(async dir => {
  const shell = 'alert_status=0; "$NODE" "$CLASSIFIER" || alert_status=$?; if [[ "$alert_status" != 10 ]]; then printf ALERT_SENT >> "$OUT/alerts"; fi; exit 1';
  const brokenFile = path.join(dir, 'broken.mjs');
  await writeFile(brokenFile, 'throw new Error("synthetic classifier failure");');
  for (const file of [path.join(dir, 'missing.mjs'), brokenFile]) {
    const result = spawnSync('/bin/bash', ['-c', shell], { env: { PATH: process.env.PATH, OUT: dir, NODE: process.execPath, CLASSIFIER: file }, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Error/);
  }
  assert.equal(await readFile(path.join(dir, 'alerts'), 'utf8'), 'ALERT_SENTALERT_SENT');
}));
test('workflow executes the classifier inside the failure step and never hides the runner exit', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/mystery-shopper.yml', import.meta.url), 'utf8');
  // From this scripts/mystery-shopper/quality-loop directory, repository root is three levels up.
  assert.match(workflow, /if: failure\(\)[\s\S]*?node scripts\/mystery-shopper\/quality-loop\/interruption-alert\.mjs \|\| alert_status=\$\?/);
  assert.match(workflow, /if \[\[ "\$alert_status" != 10 \]\]; then/);
  assert.match(workflow, /AQL_TRIGGER: \$\{\{ github\.event_name \}\}/);
  assert.doesNotMatch(workflow, /run\.ts\s*\|\|\s*true/);
  assert.match(workflow, /node --test scripts\/mystery-shopper\/quality-loop\/interruption-alert\.test\.mjs/);
});
