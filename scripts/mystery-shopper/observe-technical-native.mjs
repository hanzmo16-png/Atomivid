/** FREE readback only: no request update, ledger write, retry, provider call or settlement. */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { snapshotSha } from './technical-long-form-rerender.ts';
import { readTechnicalLedger } from './technical-run-policy.ts';
import { nativeIdentityProved, canonicalContractObservation } from './technical-observer-checks.ts';

async function main() {
  const e = process.env, id = e.MS_NEW_REQUEST_ID;
  if (e.MS_TECHNICAL_OPERATION !== 'observe-native-output' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id ?? '') || !/^\d+$/.test(e.MS_NATIVE_RUN_ID ?? '') || !e.GITHUB_TOKEN || !e.GITHUB_RUN_ID) throw Error('explicit readback identity required');
  const service = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = service.storage.from('videos'), privacy = await service.storage.getBucket('videos');
  if (privacy.error || privacy.data.public !== false) throw Error('private bucket required');
  const readJson = async path => { const r = await bucket.download(path); if (r.error || !r.data) throw Error('private journal unavailable'); return JSON.parse(await r.data.text()); };
  if (!/^mystery-shopper\/v3\/receipts\/technical-rerender-review-\d+\.json$/.test(e.MS_REVIEW_RECEIPT ?? '') || !/^mystery-shopper\/v3\/receipts\/technical-deployment-proof-\d+\.json$/.test(e.MS_DEPLOYMENT_RECEIPT ?? '')) throw Error('private proof paths required');
  const review = await readJson(e.MS_REVIEW_RECEIPT), deployment = await readJson(e.MS_DEPLOYMENT_RECEIPT);
  if (review.reviewSha256 !== e.MS_ACCEPTED_REVIEW_SHA || snapshotSha({ payload: review.payload, provenance: review.provenance }) !== e.MS_ACCEPTED_REVIEW_SHA || review.payload.id !== id || deployment.requestId !== id || deployment.reviewSha256 !== e.MS_ACCEPTED_REVIEW_SHA || deployment.nativeDarkQc !== true || deployment.privateProviderLogs !== true) throw Error('review/deployed proof mismatch');
  const authClient = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await authClient.auth.signInWithPassword({ email: e.MYSTERY_SHOPPER_QA_EMAIL, password: e.MYSTERY_SHOPPER_QA_PASSWORD });
  if (login.error || !login.data.user?.email_confirmed_at || login.data.user.id !== review.payload.user_id) throw Error('QA owner mismatch');
  const ownerId = login.data.user.id; await authClient.auth.signOut({ scope: 'local' });
  const headers = { Authorization: `Bearer ${e.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' };
  const api = async path => { const r = await fetch(`https://api.github.com/repos/${e.GITHUB_REPOSITORY}/${path}`, { headers }); if (!r.ok) throw Error('native job proof unavailable'); return r.json(); };
  const run = await api(`actions/runs/${e.MS_NATIVE_RUN_ID}`), jobs = await api(`actions/runs/${e.MS_NATIVE_RUN_ID}/jobs?per_page=100`);
  if (!Array.isArray(jobs.jobs) || jobs.total_count >= 100) throw Error('native jobs incomplete');
  const logs = [];
  for (const job of jobs.jobs) {
    if (job.name !== 'render') { logs.push(''); continue; }
    const r = await fetch(`https://api.github.com/repos/${e.GITHUB_REPOSITORY}/actions/jobs/${job.id}/logs`, { headers });
    if (!r.ok || Number(r.headers.get('content-length') ?? 0) > 10_000_000) throw Error('native exact job log unavailable');
    const text = await r.text(); if (text.length > 10_000_000) throw Error('native log bound'); logs.push(text);
  }
  if (!nativeIdentityProved(run, jobs.jobs, logs, id, deployment.productionSha)) throw Error('native job/request/source identity not proved');
  const [request, operations, costs] = await Promise.all([
    service.from('video_requests').select('id,user_id,status,mode,duration_seconds,render_attempts,video_path,long_form_stage,long_form_progress,script_json').eq('id', id).single(),
    service.from('pi_paid_operations').select('idempotency_key,provider,method,status,reserved_usd,committed_usd,result_ref').eq('project_id', id).limit(1000),
    service.from('generation_costs').select('script_calls,voice_provider,voice_characters,music_provider,video_duration_seconds,render_ms,estimated_cost_usd,image_cost_usd,premium_video_cost_usd').eq('request_id', id).maybeSingle(),
  ]);
  if (request.error || operations.error || costs.error || operations.data.length >= 1000 || request.data.user_id !== ownerId || snapshotSha(request.data.script_json) !== review.provenance.sourceScriptSha256) throw Error('owner or native journal unreadable');
  const row = request.data, ledger = await readTechnicalLedger(bucket), key = `technical-${id}-render`;
  const reservation = ledger.reservations.find(r => r.key === key);
  if (!reservation || reservation.module !== 'youtube' || reservation.reservedUsd > 2) throw Error('exact new run reservation missing');
  const receipt = { scope: 'FREE_TECHNICAL_NATIVE_OBSERVER_NO_SETTLEMENT', requestId: id, ownerVerified: true, reviewSha256: e.MS_ACCEPTED_REVIEW_SHA, nativeRunId: Number(e.MS_NATIVE_RUN_ID), nativeHeadSha: run.head_sha, nativeStatus: run.status, nativeConclusion: run.conclusion, workerClosed: run.status === 'completed' && jobs.jobs.every(j => j.status === 'completed'), exitMarkerFound: logs.some(log => /LONG_FORM_PROCESS_FINISHED: exit=0/.test(log)), requestStatus: row.status, stage: row.long_form_stage, progress: row.long_form_progress, attempts: row.render_attempts, operations: operations.data, generationCosts: costs.data, reservationKey: key, reservedUsd: reservation.reservedUsd, settlementPresent: ledger.settlements.some(s => s.key === key), noSettlementWritten: true, paidCalls: 0, status: 'INCOMPLETE' };
  const journal = {};
  for (const [name, path] of Object.entries({ output: `${id}/state/output.json`, requestBudget: `${id}/state/request-budget.json`, productionBudget: `${id}/state/production-budget.json` })) {
    try { journal[name] = await readJson(path); } catch { journal[name] = { unavailable: true }; }
  }
  receipt.journal = journal;
  receipt.canonicalProbe = journal.output?.delivered ?? null;
  receipt.openOperationCount = operations.data.filter(op => !['COMMITTED', 'REFUNDED'].includes(op.status)).length;
  receipt.unverifiedCommittedCount = operations.data.filter(op => op.status === 'COMMITTED' && (op.committed_usd === null || !Number.isFinite(Number(op.committed_usd)) || Number(op.committed_usd) < 0)).length;
  receipt.unverifiedRefundCount = operations.data.filter(op => op.status === 'REFUNDED' && !/^(released:|reconciled:not_charged:|rejected:rejected_final:)/.test(op.result_ref ?? '')).length;
  if (receipt.workerClosed && run.conclusion === 'success' && receipt.exitMarkerFound && row.status === 'completed') {
    let failureCategory = 'CANONICAL_LISTING_UNAVAILABLE';
    try {
    const listed = await bucket.list(`${id}/output`, { limit: 100, search: 'final.mp4' });
    const object = listed.data?.find(file => file.name === 'final.mp4'), size = Number(object?.metadata?.size);
    if (listed.error || !Array.isArray(listed.data) || listed.data.length >= 100) throw Error('canonical listing unavailable');
    const observation = canonicalContractObservation(row, journal.output, size);
    receipt.canonicalObjectBytes = Number.isFinite(size) ? size : null;
    receipt.nativeRecordedSha256 = journal.output?.sha256 ?? null;
    if (!observation.ready) { failureCategory = observation.failureCategory; throw Error('canonical contract rejected'); }
    failureCategory = 'CANONICAL_DOWNLOAD_UNAVAILABLE';
    const file = await bucket.download(`${id}/output/final.mp4`);
    if (file.error || !file.data) throw Error('canonical MP4 unavailable');
    const bytes = Buffer.from(await file.data.arrayBuffer()), sha256 = createHash('sha256').update(bytes).digest('hex');
    receipt.observedCanonicalSha256 = sha256; receipt.observedCanonicalBytes = bytes.length;
    failureCategory = 'CANONICAL_HASH_OR_SIZE_MISMATCH';
    if (bytes.length !== size || sha256 !== journal.output.sha256) throw Error('canonical full-file hash or size mismatch');
    failureCategory = 'CANONICAL_LOCATOR_UNAVAILABLE';
    const signed = await bucket.createSignedUrl(`${id}/output/final.mp4`, 300);
    if (signed.error || !signed.data?.signedUrl) throw Error('canonical locator unavailable');
    const url = new URL(signed.data.signedUrl), trusted = new URL(e.NEXT_PUBLIC_SUPABASE_URL);
    failureCategory = 'CANONICAL_LOCATOR_BINDING_REJECTED';
    if (url.protocol !== 'https:' || url.origin !== trusted.origin || url.pathname !== `/storage/v1/object/sign/videos/${id}/output/final.mp4`) throw Error('locator host/path binding');
    receipt.canonicalSha256 = sha256; receipt.canonicalBytes = size; receipt.canonicalProbe = journal.output.delivered;
    receipt.signedUrl = url.href; receipt.locatorExpiresAt = Date.now() + 300_000;
    receipt.status = 'NATIVE_VERIFIED_LOCATOR_READY_PENDING_INDEPENDENT_QC_AND_COST_REVIEW';
    } catch {
      receipt.status = 'CANONICAL_CONTRACT_BLOCKED'; receipt.failureCategory = failureCategory;
      delete receipt.signedUrl; delete receipt.locatorExpiresAt;
    }
  }
  const statusCounts = {}, providerJournal = {};
  for (const op of operations.data) {
    statusCounts[op.status] = (statusCounts[op.status] ?? 0) + 1;
    if (op.method === 'capacity_hold') continue;
    const summary = providerJournal[op.provider] ??= { committedUsd: 0, pendingReservedUsd: 0, operationCount: 0 };
    summary.operationCount++;
    if (op.status === 'COMMITTED' && op.committed_usd !== null && Number.isFinite(Number(op.committed_usd)) && Number(op.committed_usd) >= 0) summary.committedUsd += Number(op.committed_usd);
    else if (op.status !== 'REFUNDED' || !/^(released:|reconciled:not_charged:|rejected:rejected_final:)/.test(op.result_ref ?? '')) summary.pendingReservedUsd += Number(op.reserved_usd ?? 0);
  }
  // Keep headers small: full durable journals stay in the private object body, not upload metadata headers.
  const metadata = { scope: receipt.scope, status: receipt.status, failureCategory: receipt.failureCategory ?? null, nativeRecordedSha256: receipt.nativeRecordedSha256 ?? null, canonicalObjectBytes: receipt.canonicalObjectBytes ?? null, observedCanonicalSha256: receipt.observedCanonicalSha256 ?? null, observedCanonicalBytes: receipt.observedCanonicalBytes ?? null, requestId: id, ownerVerified: true, nativeRunId: receipt.nativeRunId, nativeHeadSha: receipt.nativeHeadSha, nativeStatus: receipt.nativeStatus, nativeConclusion: receipt.nativeConclusion, workerClosed: receipt.workerClosed, exitMarkerFound: receipt.exitMarkerFound, requestStatus: row.status, stage: row.long_form_stage, attempts: row.render_attempts, operationStatusCounts: statusCounts, providerJournal, generationCosts: costs.data, openOperationCount: receipt.openOperationCount, unverifiedRefundCount: receipt.unverifiedRefundCount, unverifiedCommittedCount: receipt.unverifiedCommittedCount, reservedUsd: receipt.reservedUsd, settlementPresent: receipt.settlementPresent, requestBudgetCeilingUsd: journal.requestBudget?.ceilingUsd ?? null, productionBudgetUsed: journal.productionBudget?.used ?? null, outputStatus: journal.output?.status ?? null, nativeBlackQc: journal.output?.nativeBlackQc ?? null, canonicalSha256: receipt.canonicalSha256 ?? null, canonicalBytes: receipt.canonicalBytes ?? null, canonicalProbe: receipt.canonicalProbe ?? null, signedUrl: receipt.signedUrl ?? null, locatorExpiresAt: receipt.locatorExpiresAt ?? null, noSettlementWritten: true, paidCalls: 0 };
  const saved = await bucket.upload(`mystery-shopper/v3/receipts/technical-native-observer-${e.GITHUB_RUN_ID}.json`, JSON.stringify(receipt), { contentType: 'application/json', upsert: false, metadata });
  if (saved.error) throw Error('private observation receipt unavailable');
  if (receipt.status === 'CANONICAL_CONTRACT_BLOCKED') process.exitCode = 1;
  console.log('Bounded free native journal/locator observation saved privately. No URL, media, expense or settlement in GitHub output.');
}
main().catch(() => { console.error('Private native observation blocked; no generation, retry or settlement sent.'); process.exitCode = 1; });
