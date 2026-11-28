/** Failure-step classifier only. Does not read the queue or send an alert. */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function expectedCycleId(env) {
  if (!/^\d+$/.test(env.GITHUB_RUN_ID || '')) return null;
  if (env.AQL_TRIGGER === 'schedule') return `schedule-${env.GITHUB_RUN_ID}`;
  if (env.AQL_TRIGGER === 'workflow_dispatch') return `manual-${env.GITHUB_RUN_ID}`;
  if (env.AQL_TRIGGER === 'deployment_status' && /^\d+$/.test(env.AQL_DEPLOYMENT_ID || '')
    && /^[a-f0-9]{40}$/.test(env.AQL_EXPECTED_SHA || ''))
    return `deployment-${env.AQL_DEPLOYMENT_ID}-${env.AQL_EXPECTED_SHA}`;
  return null;
}

export async function shouldAlertInterruption(directory, expectedId) {
  if (!directory || !expectedId) return true;
  // A completed observation already reports its own FAIL/BLOCKED result.
  try { if ((await stat(path.join(directory, 'cycle.json'))).isFile()) return false; } catch { /* inspect replay receipt */ }
  try {
    const r = JSON.parse(await readFile(path.join(directory, 'skipped.json'), 'utf8'));
    const o = r?.originalOutcome, counts = o?.counts;
    const validCounts = counts && ['PASS', 'FAIL', 'BLOCKED', 'SKIP'].every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0);
    // Only an exact validated negative replay explains this failed step. Never suppress
    // a missing/corrupt receipt, another cycle, STOP/lease, or an unrelated later failure.
    return !(r.id === expectedId && r.state === 'ALREADY_COMPLETED'
      && r.validation === 'NO_REVALIDATION' && r.spendUsd === 0
      && o?.basis === 'PERSISTED_CHECK_STATES' && o.exitCode === 1
      && validCounts && (counts.FAIL > 0 || counts.BLOCKED > 0));
  } catch { return true; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const alert = await shouldAlertInterruption(process.env.OUT, expectedCycleId(process.env));
  console.log(alert ? 'INTERRUPTION_ALERT_REQUIRED' : 'NO_INTERRUPTION_ALERT: completed observation or negative replay; no revalidation');
  // Shell uses this solely as its `if` condition, never as the job's validation result.
  // Dedicated status: an accidental import/runtime error must still request an alert.
  process.exitCode = alert ? 0 : 10;
}
