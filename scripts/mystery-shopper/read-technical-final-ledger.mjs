/** FREE full immutable-ledger readback. No settle/reserve/update/retry path; independent of repaired media SHA. */
import { createClient } from '@supabase/supabase-js';
import { snapshotSha } from './technical-long-form-rerender.ts';
import { readTechnicalLedger } from './technical-run-policy.ts';
import { totals } from '../../src/lib/mystery-shopper/v3/ledger.ts';
async function main() {
  const e = process.env, id = e.MS_NEW_REQUEST_ID;
  if (e.MS_TECHNICAL_OPERATION !== 'read-final-ledger' || !e.GITHUB_RUN_ID || !e.GITHUB_ACTOR || e.GITHUB_ACTOR.toLowerCase() !== e.GITHUB_REPOSITORY_OWNER?.toLowerCase() || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id ?? '') || !/^[0-9a-f]{64}$/.test(e.MS_ACCEPTED_REVIEW_SHA ?? '') || !/^mystery-shopper\/v3\/receipts\/technical-rerender-review-\d+\.json$/.test(e.MS_REVIEW_RECEIPT ?? '')) throw Error('root exact QA review required');
  const service = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = service.storage.from('videos'), privacy = await service.storage.getBucket('videos');
  if (privacy.error || privacy.data.public !== false) throw Error('private ledger required');
  const read = await bucket.download(e.MS_REVIEW_RECEIPT); if (read.error || !read.data) throw Error('private source review unavailable');
  const review = JSON.parse(await read.data.text());
  if (review.reviewSha256 !== e.MS_ACCEPTED_REVIEW_SHA || snapshotSha({ payload: review.payload, provenance: review.provenance }) !== e.MS_ACCEPTED_REVIEW_SHA || review.payload.id !== id || review.provenance.newRequestId !== id) throw Error('review identity mismatch');
  const authClient = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await authClient.auth.signInWithPassword({ email: e.MYSTERY_SHOPPER_QA_EMAIL, password: e.MYSTERY_SHOPPER_QA_PASSWORD });
  if (login.error || !login.data.user?.email_confirmed_at || login.data.user.id !== review.payload.user_id) throw Error('QA owner mismatch');
  const ownerId = login.data.user.id; await authClient.auth.signOut({ scope: 'local' });
  const row = await service.from('video_requests').select('user_id,status,mode,duration_seconds,render_attempts,script_json').eq('id', id).single();
  if (row.error || row.data.user_id !== ownerId || row.data.mode !== 'long_form' || row.data.duration_seconds !== 180 || row.data.render_attempts !== 1 || snapshotSha(row.data.script_json) !== review.provenance.sourceScriptSha256) throw Error('new QA request/source binding mismatch');
  const state = await readTechnicalLedger(bucket), second = await readTechnicalLedger(bucket);
  if (snapshotSha(state) !== snapshotSha(second)) throw Error('ledger changed during readback; no stable snapshot claimed');
  const summary = totals(state), key = `technical-${id}-render`, reservation = state.reservations.find(r => r.key === key), settlement = state.settlements.find(s => s.key === key);
  if (!reservation || reservation.module !== 'youtube') throw Error('technical reservation missing');
  const receipt = { scope: 'FREE_FULL_TECHNICAL_LEDGER_READBACK_NO_FINANCIAL_WRITE', requestId: id, reviewSha256: e.MS_ACCEPTED_REVIEW_SHA, ownerVerified: true, snapshotAt: new Date().toISOString(), stableDoubleRead: true, fullLedgerSha256: snapshotSha(state), ledger: state, totals: summary, remainingUsd: Math.round((8.5 - summary.committedUsd) * 100) / 100, reservation, settlement: settlement ?? null, reservationCount: state.reservations.length, settlementCount: state.settlements.length, settlementPresent: !!settlement, globalCapUsd: 8.5, withinGlobalCap: summary.committedUsd <= 8.5, requestStatus: row.data.status, noFinancialWrite: true, paidCalls: 0, mediaShaRequired: false, snapshotOnlyNotConcurrentSpendAuthorization: true };
  const metadata = { ...receipt }; delete metadata.ledger;
  const saved = await bucket.upload(`mystery-shopper/v3/receipts/technical-final-ledger-${e.GITHUB_RUN_ID}.json`, JSON.stringify(receipt), { contentType: 'application/json', upsert: false, metadata });
  if (saved.error) throw Error('private full-ledger receipt unavailable');
  console.log('Full immutable ledger read back privately. No financial values published and no ledger, media or request mutation.');
}
main().catch(() => { console.error('Private final-ledger readback unavailable or changed; no financial write or retry attempted.'); process.exitCode = 1; });
