import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialQueue, publicView } from './model';
test('nominal next evaluation agrees with registered cron, including rollover', () => {
 assert.match(readFileSync('.github/workflows/mystery-shopper.yml','utf8'),/cron: "23,53 \* \* \* \*"/);
 const cases=[['12:00','12:23'],['12:22','12:23'],['12:23','12:53'],['12:52','12:53'],['12:53','13:23'],['23:59','00:23']];
 for(const [at,next] of cases){const day=next==='00:23'?'28':'27';assert.equal(publicView(initialQueue("2026-11-27T12:00:00.000Z"),`2026-11-27T${at}:00.000Z`).nextEvaluation,`2026-11-${day}T${next}:00.000Z`);}
 const q=initialQueue("2026-11-27T12:00:00.000Z");q.enabled=false;assert.equal(publicView(q,'2026-11-27T12:00:00.000Z').nextEvaluation,null);
});
