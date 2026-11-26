/** ROOT ONLY. Records already reviewed source gates, never discovers or approves them by elapsed time. */
import { createClient } from '@supabase/supabase-js';
import { snapshotSha } from './technical-long-form-rerender.ts';

async function main() {
  const e = process.env, now = Date.now(), expiry = Date.parse(e.MS_PROOF_EXPIRES_AT ?? '');
  if (e.MS_TECHNICAL_OPERATION !== 'record-reviewed-production-proof' || e.MS_ROOT_SOURCE_REVIEW !== 'native-dark-qc-and-private-provider-logs-reviewed' || !e.GITHUB_RUN_ID || !e.GITHUB_ACTOR || e.GITHUB_ACTOR.toLowerCase() !== e.GITHUB_REPOSITORY_OWNER?.toLowerCase() || !/^[0-9a-f]{40}$/.test(e.MS_ROOT_PRODUCTION_SHA ?? '') || !/^\d+$/.test(e.MS_ROOT_DEPLOYMENT_ID ?? '') || !/^[0-9a-f]{64}$/.test(e.MS_ACCEPTED_REVIEW_SHA ?? '') || !(expiry > now && expiry <= now + 60 * 60_000)) throw Error('root source review and explicit expiry required');
  if (!/^mystery-shopper\/v3\/receipts\/technical-rerender-review-\d+\.json$/.test(e.MS_REVIEW_RECEIPT ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(e.GITHUB_REPOSITORY ?? '') || !e.GITHUB_TOKEN) throw Error('review and repository binding required');
  const headers = { Authorization: `Bearer ${e.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' };
  const deployments = await fetch(`https://api.github.com/repos/${e.GITHUB_REPOSITORY}/deployments?environment=Production&per_page=1`, { headers });
  if (!deployments.ok) throw Error('production deployment unreadable');
  const [latest] = await deployments.json();
  if (!latest || latest.sha !== e.MS_ROOT_PRODUCTION_SHA || String(latest.id) !== e.MS_ROOT_DEPLOYMENT_ID || latest.environment !== 'Production') throw Error('latest production source differs from reviewed SHA/id');
  const statuses = await fetch(`https://api.github.com/repos/${e.GITHUB_REPOSITORY}/deployments/${latest.id}/statuses?per_page=1`, { headers });
  if (!statuses.ok || (await statuses.json())[0]?.state !== 'success') throw Error('reviewed production deployment not successful');
  const service = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = service.storage.from('videos'), privacy = await service.storage.getBucket('videos');
  if (privacy.error || privacy.data.public !== false) throw Error('private proof required');
  const read = await bucket.download(e.MS_REVIEW_RECEIPT);
  if (read.error) throw Error('private reviewed request unavailable');
  const review = JSON.parse(await read.data.text());
  if (review.reviewSha256 !== e.MS_ACCEPTED_REVIEW_SHA || snapshotSha({ payload: review.payload, provenance: review.provenance }) !== e.MS_ACCEPTED_REVIEW_SHA || review.payload.id !== e.MS_NEW_REQUEST_ID || review.provenance.newRequestId !== e.MS_NEW_REQUEST_ID) throw Error('request review binding differs');
  const row = await service.from('video_requests').select('user_id,status,mode,duration_seconds,render_attempts,long_form_confirmed_at,long_form_production_plan,video_path,script_json').eq('id', e.MS_NEW_REQUEST_ID).single();
  if (row.error || row.data.user_id !== review.payload.user_id || row.data.status !== 'script_ready' || row.data.mode !== 'long_form' || row.data.duration_seconds !== 180 || row.data.render_attempts !== 0 || row.data.long_form_confirmed_at || row.data.long_form_production_plan || row.data.video_path || snapshotSha(row.data.script_json) !== review.provenance.sourceScriptSha256) throw Error('reviewed target changed');
  const receipt = { scope: 'ROOT_VERIFIED_PRODUCTION_PAID_QA_GATES', requestId: e.MS_NEW_REQUEST_ID, reviewSha256: e.MS_ACCEPTED_REVIEW_SHA, target: 'https://atomivid.vercel.app', nativeDarkQc: true, privateProviderLogs: true, productionSha: latest.sha, githubDeploymentId: latest.id, environment: latest.environment, sourceReviewedBy: e.GITHUB_ACTOR, reviewedAt: new Date(now).toISOString(), expiresAt: new Date(expiry).toISOString() };
  const saved = await bucket.upload(`mystery-shopper/v3/receipts/technical-deployment-proof-${e.GITHUB_RUN_ID}.json`, JSON.stringify(receipt), { contentType: 'application/json', upsert: false, metadata: { ...receipt, deploymentReceiptSha256: snapshotSha(receipt), paidCalls: 0, noAllocationCreated: true } });
  if (saved.error) throw Error('private proof recording unavailable');
  console.log('Root-reviewed deployment proof recorded privately. No financial authorization or paid action.');
}
main().catch(() => { console.error('Root deployment proof refused; no source readiness or financial approval inferred.'); process.exitCode = 1; });
