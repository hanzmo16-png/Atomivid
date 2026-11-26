/** ROOT-ONLY manual recording of an actual owner reply. Never run while the owner reply is pending. */
import { createClient } from '@supabase/supabase-js';
import { snapshotSha, prepareTechnicalRerender, verifiedReview, ANCHOR_ID } from './technical-long-form-rerender.ts';
import { readTechnicalLedger, technicalReserveRefusal, TECHNICAL_POLICY, allocationRefusal } from './technical-run-policy.ts';

async function main() {
  const e = process.env;
  if (e.MS_TECHNICAL_OPERATION !== 'record-owner-allocation' || e.MS_ROOT_ACTUAL_REPLY_REVIEWED !== '1' || !e.GITHUB_RUN_ID || !e.GITHUB_ACTOR || e.GITHUB_ACTOR.toLowerCase() !== e.GITHUB_REPOSITORY_OWNER?.toLowerCase() || !e.MS_OWNER_REPLY_REF?.trim() || /^(pending|none|unknown|placeholder)$/i.test(e.MS_OWNER_REPLY_REF.trim()) || !/^[0-9a-f]{64}$/.test(e.MS_OWNER_REPLY_SHA ?? '')) throw Error('actual owner reply reference/hash and repository-owner review required');
  if (!/^mystery-shopper\/v3\/receipts\/technical-rerender-review-\d+\.json$/.test(e.MS_REVIEW_RECEIPT ?? '') || !/^[0-9a-f]{64}$/.test(e.MS_ACCEPTED_REVIEW_SHA ?? '')) throw Error('review binding required');
  const service = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = service.storage.from('videos'), privacy = await service.storage.getBucket('videos');
  if (privacy.error || privacy.data.public !== false) throw Error('private proof required');
  const authClient = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await authClient.auth.signInWithPassword({ email: e.MYSTERY_SHOPPER_QA_EMAIL, password: e.MYSTERY_SHOPPER_QA_PASSWORD });
  if (login.error || !login.data.user?.email_confirmed_at) throw Error('QA owner authentication required');
  const ownerId = login.data.user.id;
  await authClient.auth.signOut({ scope: 'local' });
  const read = await bucket.download(e.MS_REVIEW_RECEIPT);
  if (read.error) throw Error('review unavailable');
  const review = JSON.parse(await read.data.text());
  const load = async id => { const r = await service.from('video_requests').select('id,user_id,status,mode,duration_seconds,render_attempts,language,style,aspect_ratio,topic,script_json,video_path,long_form_confirmed_at,long_form_production_plan').eq('id', id).single(); if (r.error) throw Error('request unavailable'); return r.data; };
  const source = await load(review.provenance?.sourceRequestId), anchor = await load(ANCHOR_ID), target = await load(e.MS_NEW_REQUEST_ID);
  const output = await bucket.download(`${source.id}/state/output.json`);
  if (output.error) throw Error('native source unavailable');
  verifiedReview(prepareTechnicalRerender(source, JSON.parse(await output.data.text()), ownerId, anchor.user_id, e.MS_NEW_REQUEST_ID), review, e.MS_ACCEPTED_REVIEW_SHA);
  if (target.user_id !== ownerId || target.mode !== 'long_form' || target.duration_seconds !== 180 || target.status !== 'script_ready' || target.render_attempts !== 0 || target.long_form_confirmed_at || target.long_form_production_plan || target.video_path || snapshotSha(target.script_json) !== review.provenance.sourceScriptSha256) throw Error('new request not untouched');
  const ledger = await readTechnicalLedger(bucket);
  if (technicalReserveRefusal(ledger, `technical-${e.MS_NEW_REQUEST_ID}-render`, 2)) throw Error('current allocation cannot admit the maximum new exposure');
  const now = new Date(), receipt = { scope: 'OWNER_APPROVED_ONE_TECHNICAL_LONG_FORM_RUN', approved: true, requestId: e.MS_NEW_REQUEST_ID, reviewSha256: e.MS_ACCEPTED_REVIEW_SHA, ownerId, ownerReplyRef: e.MS_OWNER_REPLY_REF.trim(), ownerReplySha256: e.MS_OWNER_REPLY_SHA, recordedBy: e.GITHUB_ACTOR, approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(), maxNewUsd: 2, totalCapUsd: 8.5, reservedAvUsd: 3, moduleCaps: TECHNICAL_POLICY, ledgerBaselineSha256: snapshotSha(ledger) };
  if (allocationRefusal(receipt, { requestId: e.MS_NEW_REQUEST_ID, reviewSha256: e.MS_ACCEPTED_REVIEW_SHA, ownerId, now: Date.now() })) throw Error('receipt validation failed');
  const saved = await bucket.upload(`mystery-shopper/v3/receipts/technical-owner-allocation-${e.GITHUB_RUN_ID}.json`, JSON.stringify(receipt), { contentType: 'application/json', upsert: false, metadata: { scope: receipt.scope, allocationSha256: snapshotSha(receipt), reviewSha256: receipt.reviewSha256, requestId: receipt.requestId, ownerReplySha256: receipt.ownerReplySha256, ledgerBaselineSha256: receipt.ledgerBaselineSha256, expiresAt: receipt.expiresAt, explicitReplyReviewed: true, paidCalls: 0, noReservationCreated: true } });
  if (saved.error) throw Error('private record unavailable');
  console.log('Actual owner reply recorded privately by repository owner. No reservation, confirmation or generation.');
}
main().catch(() => { console.error('Owner approval recording refused or unavailable; no approval inferred and no paid action sent.'); process.exitCode = 1; });
