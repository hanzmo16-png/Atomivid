/** ROOT ONLY explicit post-run accounting. Never generates, retries, edits requests, or claims output quality. */
import { createClient } from '@supabase/supabase-js';
import { snapshotSha } from './technical-long-form-rerender.ts';
import { readTechnicalLedger } from './technical-run-policy.ts';
import { technicalSettlementAmount } from './technical-settlement-checks.ts';
async function main() {
  const e = process.env, id = e.MS_NEW_REQUEST_ID, reviewOnly = e.MS_TECHNICAL_OPERATION === 'review-closed-native-cost';
  if ((!reviewOnly && (e.MS_TECHNICAL_OPERATION !== 'settle-root-reviewed-native-cost' || e.MS_ROOT_COST_REVIEWED !== '1' || !/^[0-9a-f]{64}$/.test(e.MS_OBSERVER_SHA ?? ''))) || !e.GITHUB_ACTOR || e.GITHUB_ACTOR.toLowerCase() !== e.GITHUB_REPOSITORY_OWNER?.toLowerCase() || !e.GITHUB_RUN_ID || !e.GITHUB_TOKEN || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id ?? '') || !/^\d+$/.test(e.MS_NATIVE_RUN_ID ?? '') || !/^[0-9a-f]{64}$/.test(e.MS_ROOT_CANONICAL_SHA ?? '') || !/^[0-9a-f]{64}$/.test(e.MS_ACCEPTED_REVIEW_SHA ?? '')) throw Error('explicit root cost review bindings required');
  if (!/^mystery-shopper\/v3\/receipts\/technical-native-observer-\d+\.json$/.test(e.MS_OBSERVER_RECEIPT ?? '') || !/^mystery-shopper\/v3\/receipts\/technical-rerender-review-\d+\.json$/.test(e.MS_REVIEW_RECEIPT ?? '')) throw Error('private observer/source review required');
  const service = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = service.storage.from('videos'), privacy = await service.storage.getBucket('videos');
  if (privacy.error || privacy.data.public !== false) throw Error('private evidence required');
  const json = async path => { const r = await bucket.download(path); if (r.error || !r.data) throw Error('private proof unavailable'); return JSON.parse(await r.data.text()); };
  const observer = await json(e.MS_OBSERVER_RECEIPT);
  const review = await json(e.MS_REVIEW_RECEIPT);
  if (review.reviewSha256 !== e.MS_ACCEPTED_REVIEW_SHA || snapshotSha({ payload: review.payload, provenance: review.provenance }) !== e.MS_ACCEPTED_REVIEW_SHA || review.payload.id !== id || review.provenance.newRequestId !== id || !['FREE_TECHNICAL_NATIVE_OBSERVER_NO_SETTLEMENT', 'UNAPPROVED_CANONICAL_DIAGNOSTIC'].includes(observer.scope) || observer.noSettlementWritten !== true || observer.settlementPresent !== false) throw Error('original source review or observer scope mismatch');
  const observerSha256 = snapshotSha(observer);
  if ((!reviewOnly && observerSha256 !== e.MS_OBSERVER_SHA) || observer.requestId !== id || observer.reviewSha256 !== e.MS_ACCEPTED_REVIEW_SHA || observer.ownerVerified !== true || observer.workerClosed !== true || observer.nativeStatus !== 'completed' || observer.nativeConclusion !== 'success' || observer.exitMarkerFound !== true || String(observer.nativeRunId) !== e.MS_NATIVE_RUN_ID || observer.attempts !== 1 || observer.requestStatus !== 'completed' || observer.openOperationCount !== 0 || observer.unverifiedRefundCount !== 0 || observer.unverifiedCommittedCount !== 0 || observer.journal?.output?.sha256 !== e.MS_ROOT_CANONICAL_SHA || observer.journal.output.status !== 'UPLOADED' || observer.journal.output.nativeBlackQc !== 'passed-v1' || observer.journal.output.costsRecorded !== true) throw Error('exact root-reviewed closed native journal not proved');
  const native = await fetch(`https://api.github.com/repos/${e.GITHUB_REPOSITORY}/actions/runs/${e.MS_NATIVE_RUN_ID}`, { headers: { Authorization: `Bearer ${e.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } });
  if (!native.ok) throw Error('native closure unavailable');
  const run = await native.json();
  if (run.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== observer.nativeHeadSha || run.event !== 'repository_dispatch' || run.path?.split('@')[0] !== '.github/workflows/render.yml') throw Error('native job closure/source changed');
  const authClient = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await authClient.auth.signInWithPassword({ email: e.MYSTERY_SHOPPER_QA_EMAIL, password: e.MYSTERY_SHOPPER_QA_PASSWORD });
  if (login.error || !login.data.user?.email_confirmed_at) throw Error('QA owner authentication required');
  const owner = login.data.user.id; await authClient.auth.signOut({ scope: 'local' });
  const [request, operations, costs] = await Promise.all([
    service.from('video_requests').select('user_id,status,mode,duration_seconds,render_attempts,video_path,script_json').eq('id', id).single(),
    service.from('pi_paid_operations').select('idempotency_key,provider,method,status,reserved_usd,committed_usd,result_ref').eq('project_id', id).limit(1000),
    service.from('generation_costs').select('script_calls,voice_provider,voice_characters,music_provider,video_duration_seconds,render_ms,estimated_cost_usd,image_cost_usd,premium_video_cost_usd').eq('request_id', id).single(),
  ]);
  if (request.error || operations.error || costs.error || operations.data.length >= 1000 || request.data.user_id !== owner || owner !== review.payload.user_id || snapshotSha(request.data.script_json) !== review.provenance.sourceScriptSha256 || request.data.status !== 'completed' || request.data.mode !== 'long_form' || request.data.duration_seconds !== 180 || request.data.render_attempts !== 1 || request.data.video_path !== `${id}/output/final.mp4`) throw Error('native owner/identity/source no longer matches');
  const sorted = list => [...list].sort((a, b) => a.idempotency_key.localeCompare(b.idempotency_key));
  if (snapshotSha(sorted(operations.data)) !== snapshotSha(sorted(observer.operations)) || snapshotSha(costs.data) !== snapshotSha(observer.generationCosts)) throw Error('native cost journal changed after root review');
  const output = await json(`${id}/state/output.json`);
  if (output.requestId !== id || output.objectPath !== request.data.video_path || output.status !== 'UPLOADED' || output.sha256 !== e.MS_ROOT_CANONICAL_SHA || output.nativeBlackQc !== 'passed-v1' || output.costsRecorded !== true) throw Error('original native output changed');
  const ledger = await readTechnicalLedger(bucket), key = `technical-${id}-render`, reservation = ledger.reservations.find(r => r.key === key);
  if (!reservation || observer.reservationKey !== key || reservation.reservedUsd !== observer.reservedUsd || reservation.module !== 'youtube' || ledger.settlements.some(s => s.key === key) || ledger.reservations.some(r => r.key !== key && !ledger.settlements.some(s => s.key === r.key))) throw Error('one unsettled exact reservation required; no other open exposure');
  // Expected amount derives only from the exact private observer root reviewed; never a public expense input.
  const observedProvider = observer.operations.filter(op => op.method !== 'capacity_hold').reduce((sum, op) => sum + Number(op.committed_usd), 0);
  const expected = Math.ceil((Math.max(observedProvider, Number(observer.generationCosts.estimated_cost_usd)) - Number.EPSILON) * 100) / 100;
  const amount = technicalSettlementAmount(operations.data, costs.data, reservation.reservedUsd, expected);
  if (reviewOnly) {
    const proposal = { scope: 'TECHNICAL_NATIVE_COST_REVIEW_ONLY', requestId: id, observerSha256, nativeRunId: Number(e.MS_NATIVE_RUN_ID), nativeSha256: e.MS_ROOT_CANONICAL_SHA, reviewSha256: e.MS_ACCEPTED_REVIEW_SHA, expectedUsd: amount, reservedUsd: reservation.reservedUsd, providerActualUsd: observedProvider, registeredNativeUsd: Number(costs.data.estimated_cost_usd), method: 'ceil(max(providerActual, registeredNative)); never sum overlapping voice', workerClosed: true, openOperations: 0, allCommitted: true, noSettlementWritten: true, qualityApproved: false };
    const saved = await bucket.upload(`mystery-shopper/v3/receipts/technical-cost-review-${e.GITHUB_RUN_ID}.json`, JSON.stringify(proposal), { contentType: 'application/json', upsert: false, metadata: proposal });
    if (saved.error) throw Error('private review proposal unavailable');
    console.log('Closed native cost proposal saved privately for root review. No settlement or generation.'); return;
  }
  const settlement = { key, spentUsd: amount, source: `root-reviewed closed native journal; ceil(max(registered usage, committed provider actual)); not provider invoice; observer=${e.MS_OBSERVER_RECEIPT}; sha256=${e.MS_ROOT_CANONICAL_SHA}`, at: new Date().toISOString() };
  // Sole financial mutation: one create-only settlement. Never delete, overwrite, reserve or retry an ambiguous upload.
  const write = await bucket.upload(`mystery-shopper/v3/ledger/settle-${key}.json`, JSON.stringify(settlement), { contentType: 'application/json', upsert: false });
  if (write.error) throw Error('settlement write failed or uncertain; inspect before any manual action');
  if (snapshotSha(await json(`mystery-shopper/v3/ledger/settle-${key}.json`)) !== snapshotSha(settlement)) throw Error('settlement readback mismatch');
  const receipt = { scope: 'ROOT_REVIEWED_TECHNICAL_COST_SETTLED_ONCE', requestId: id, observerSha256: e.MS_OBSERVER_SHA, nativeRunId: Number(e.MS_NATIVE_RUN_ID), nativeSha256: e.MS_ROOT_CANONICAL_SHA, settlement, qualityApproved: false, invoiceVerified: false, paidCalls: 0, noRequestMutation: true };
  const saved = await bucket.upload(`mystery-shopper/v3/receipts/technical-settlement-${e.GITHUB_RUN_ID}.json`, JSON.stringify(receipt), { contentType: 'application/json', upsert: false, metadata: receipt });
  if (saved.error) throw Error('settlement receipt unavailable; original settlement must not be repeated');
  console.log('Root-reviewed existing native cost settled once and read back privately. No quality approval, generation or retry.');
}
main().catch(() => { console.error('Private settlement blocked or uncertain. Never retry automatically or alter historical rows.'); process.exitCode = 1; });
