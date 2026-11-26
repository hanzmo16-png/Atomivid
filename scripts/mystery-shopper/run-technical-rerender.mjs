/** CODE ONLY until owner allocation and root deployment receipts exist. One explicit paid UI journey; no retry. */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { prepareTechnicalRerender, verifiedReview, snapshotSha, ANCHOR_ID } from './technical-long-form-rerender.ts';
import { allocationRefusal, readTechnicalLedger, technicalReserveRefusal } from './technical-run-policy.ts';
import { workerBudgetForPlan } from '../../src/lib/video/long-form/worker-budget-preview.ts';

async function main() {
  const e = process.env, origin = 'https://atomivid.vercel.app';
  if (e.MS_TECHNICAL_OPERATION !== 'run-owner-approved' || e.MYSTERY_SHOPPER_REAL_ENABLED !== '1' || !e.GITHUB_RUN_ID || !e.GITHUB_TOKEN || !e.MS_NEW_REQUEST_ID || !/^[0-9a-f]{64}$/.test(e.MS_ACCEPTED_REVIEW_SHA ?? '')) throw Error('explicit owner-approved run inputs missing');
  const service = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = service.storage.from('videos'), privacy = await service.storage.getBucket('videos');
  if (privacy.error || privacy.data.public !== false) throw Error('private evidence required');
  const privateJson = async name => {
    if (!/^mystery-shopper\/v3\/receipts\/[a-zA-Z0-9-]+\.json$/.test(name ?? '')) throw Error('private receipt path missing');
    const read = await bucket.download(name); if (read.error || !read.data) throw Error('private proof unreadable');
    return JSON.parse(await read.data.text());
  };
  const review = await privateJson(e.MS_REVIEW_RECEIPT);
  const allocation = await privateJson(e.MS_ALLOCATION_RECEIPT);
  const deployment = await privateJson(e.MS_DEPLOYMENT_RECEIPT);
  if (snapshotSha(allocation) !== e.MS_ALLOCATION_RECEIPT_SHA || snapshotSha(deployment) !== e.MS_DEPLOYMENT_RECEIPT_SHA) throw Error('root-reviewed financial and deployment proof hashes missing');
  const id = e.MS_NEW_REQUEST_ID, key = `technical-${id}-render`, jobId = `ms-technical-${id}`;
  const receipt = { scope: 'ONE_OWNER_APPROVED_OPERATOR_TECHNICAL_RERENDER', requestId: id, reviewSha256: e.MS_ACCEPTED_REVIEW_SHA, reservationKey: key, customerFreshScriptFlowProved: false, status: 'BLOCKED', reservationRetainedOpen: false, confirmPostCount: 0, renderPostCount: 0 };
  const readRow = async requestId => {
    const q = await service.from('video_requests').select('id,user_id,status,mode,duration_seconds,render_attempts,language,style,aspect_ratio,topic,script_json,video_path,long_form_confirmed_at,long_form_production_plan').eq('id', requestId).single();
    if (q.error) throw Error('request unreadable'); return q.data;
  };
  const authClient = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const auth = await authClient.auth.signInWithPassword({ email: e.MYSTERY_SHOPPER_QA_EMAIL, password: e.MYSTERY_SHOPPER_QA_PASSWORD });
  if (auth.error || !auth.data.user?.email_confirmed_at) throw Error('QA authentication required');
  const ownerId = auth.data.user.id;
  await authClient.auth.signOut({ scope: 'local' });
  const source = await readRow(review.provenance?.sourceRequestId), anchor = await readRow(ANCHOR_ID);
  const out = await bucket.download(`${source.id}/state/output.json`);
  if (out.error) throw Error('approved native source missing');
  const prepared = prepareTechnicalRerender(source, JSON.parse(await out.data.text()), ownerId, anchor.user_id, id);
  verifiedReview(prepared, review, e.MS_ACCEPTED_REVIEW_SHA);
  const allocationCheck = () => { const reason = allocationRefusal(allocation, { requestId: id, reviewSha256: e.MS_ACCEPTED_REVIEW_SHA, ownerId, now: Date.now() }); if (reason) throw Error(reason); };
  const freshSource = async () => {
    const current = await readRow(source.id), currentAnchor = await readRow(ANCHOR_ID);
    const output = await bucket.download(`${source.id}/state/output.json`);
    if (output.error) throw Error('native source proof unavailable');
    verifiedReview(prepareTechnicalRerender(current, JSON.parse(await output.data.text()), ownerId, currentAnchor.user_id, id), review, e.MS_ACCEPTED_REVIEW_SHA);
  };
  const emptyPaidOps = async () => {
    const ops = await service.from('pi_paid_operations').select('idempotency_key').eq('project_id', id).limit(1);
    if (ops.error || ops.data.length) throw Error('new request already has paid operations');
    const jobs = await service.from('documentary_script_jobs').select('id').eq('request_id', id).limit(1);
    if (jobs.error || jobs.data.length) throw Error('operator rerender cannot hide or regenerate a script job');
  };
  const deployed = async () => {
    if (deployment.scope !== 'ROOT_VERIFIED_PRODUCTION_PAID_QA_GATES' || deployment.requestId !== id || deployment.reviewSha256 !== e.MS_ACCEPTED_REVIEW_SHA || deployment.nativeDarkQc !== true || deployment.privateProviderLogs !== true || deployment.target !== origin || !/^[0-9a-f]{40}$/.test(deployment.productionSha ?? '') || !(Date.parse(deployment.expiresAt) > Date.now())) throw Error('native QC/private logs deployed proof missing');
    const headers = { Authorization: `Bearer ${e.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' };
    const repo = e.GITHUB_REPOSITORY;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !['production', 'Production'].includes(deployment.environment)) throw Error('deployment repository binding missing');
    const response = await fetch(`https://api.github.com/repos/${repo}/deployments?environment=${deployment.environment}&per_page=1`, { headers });
    if (!response.ok) throw Error('deployment proof unavailable');
    const [latest] = await response.json();
    if (!latest || latest.id !== deployment.githubDeploymentId || latest.sha !== deployment.productionSha) throw Error('production SHA changed');
    const status = await fetch(`https://api.github.com/repos/${repo}/deployments/${latest.id}/statuses?per_page=1`, { headers });
    if (!status.ok || (await status.json())[0]?.state !== 'success') throw Error('production is not deployed successfully');
  };
  const untouched = async () => {
    const row = await readRow(id);
    if (row.user_id !== ownerId || row.status !== 'script_ready' || row.mode !== 'long_form' || row.duration_seconds !== 180 || row.render_attempts !== 0 || row.long_form_confirmed_at || row.long_form_production_plan || row.video_path || snapshotSha(row.script_json) !== prepared.provenance.sourceScriptSha256) throw Error('new request no longer untouched');
    await emptyPaidOps();
  };
  allocationCheck(); await deployed(); await untouched(); await readTechnicalLedger(bucket);
  const browser = await chromium.launch({ headless: true });
  let quote = null, allowPaid = false, confirmed = false;
  try {
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    let loggedIn = false;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (/(^|\.)(anthropic\.com|openai\.com|elevenlabs\.io|heygen\.com|fal\.ai|fal\.run|runwayml\.com|recraft\.ai|beatoven\.ai|replicate\.com|d-id\.com)$/.test(url.hostname)) return route.abort('blockedbyclient');
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
      if (!loggedIn && url.origin === origin && url.pathname === '/login' && method === 'POST') return route.continue();
      if (!allowPaid || url.origin !== origin || method !== 'POST') return route.abort('blockedbyclient');
      if (![ `/api/generate/${id}/confirm-production`, `/api/generate/${id}/render` ].includes(url.pathname)) return route.abort('blockedbyclient');
      try {
        allocationCheck(); await deployed(); await freshSource();
        const ledger = await readTechnicalLedger(bucket), reservation = ledger.reservations.find(r => r.key === key);
        const historical = { reservations: ledger.reservations.filter(r => r.key !== key), settlements: ledger.settlements };
        if (!reservation || reservation.reservedUsd !== quote || ledger.settlements.some(s => s.key === key) || snapshotSha(historical) !== allocation.ledgerBaselineSha256 || technicalReserveRefusal(historical, key, quote)) throw Error('one-shot allocation no longer valid');
        if (url.pathname === `/api/generate/${id}/confirm-production` && receipt.confirmPostCount === 0 && !confirmed) {
          await untouched();
          const body = request.postDataJSON();
          if (body.strategy !== 'economical' || body.image_source && body.image_source !== 'default') throw Error('unexpected paid material choice');
          receipt.confirmPostCount++;
          const response = await route.fetch({ maxRetries: 0 });
          if (!response.ok()) throw Error('confirmation failed; no retry');
          const payload = await response.json(), row = await readRow(id);
          if (payload.alreadyConfirmed || !row.long_form_confirmed_at || snapshotSha(payload.plan) !== snapshotSha(row.long_form_production_plan)) throw Error('confirmation identity ambiguous');
          const budget = await workerBudgetForPlan(service, payload.plan, { scriptSpentUsd: 0, hardMaxUsd: 2 });
          if (!budget.admits || !budget.authorizedCeilingUsd || budget.authorizedCeilingUsd > quote || budget.imageUsd !== 0 || budget.videoUsd !== 0) throw Error('confirmed server budget exceeds reserved total');
          confirmed = true; receipt.confirmedPlanSha256 = snapshotSha(payload.plan);
          return route.fulfill({ response });
        }
        if (url.pathname === `/api/generate/${id}/render` && confirmed && receipt.renderPostCount === 0) {
          const row = await readRow(id);
          if (row.user_id !== ownerId || row.render_attempts !== 0 || row.status !== 'script_ready' || snapshotSha(row.script_json) !== prepared.provenance.sourceScriptSha256 || snapshotSha(row.long_form_production_plan) !== receipt.confirmedPlanSha256) throw Error('confirmed request changed');
          await emptyPaidOps();
          const budget = await workerBudgetForPlan(service, row.long_form_production_plan, { scriptSpentUsd: 0, hardMaxUsd: 2 });
          if (!budget.admits || !budget.authorizedCeilingUsd || budget.authorizedCeilingUsd > quote || budget.imageUsd !== 0 || budget.videoUsd !== 0) throw Error('server quote changed before render');
          receipt.renderPostCount++;
          const headers = { ...request.headers(), 'content-type': 'application/json' }; delete headers['content-length'];
          const response = await route.fetch({ maxRetries: 0, headers, postData: JSON.stringify({ acceptedCeilingUsd: quote }) });
          receipt.startHttpStatus = response.status();
          receipt.startResponse = await response.json().catch(() => null);
          if (!response.ok() || receipt.startResponse?.status !== 'processing') throw Error('render outcome failed or unknown; hold retained');
          for (const field of ['id', 'requestId', 'request_id']) if (receipt.startResponse[field] !== undefined && receipt.startResponse[field] !== id) throw Error('render acknowledgement identity mismatch');
          const acceptedRow = await readRow(id);
          if (acceptedRow.id !== id || acceptedRow.user_id !== ownerId || acceptedRow.status !== 'processing' || acceptedRow.render_attempts !== 1 || snapshotSha(acceptedRow.script_json) !== prepared.provenance.sourceScriptSha256 || snapshotSha(acceptedRow.long_form_production_plan) !== receipt.confirmedPlanSha256) throw Error('accepted render DB identity or attempt not proved');
          receipt.status = 'START_ACCEPTED';
          return route.fulfill({ response });
        }
      } catch { receipt.status = 'BLOCKED_OR_UNKNOWN_HOLD_RETAINED'; }
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    await page.addLocatorHandler(page.getByRole('button', { name: 'Omitir', exact: true }).first(), async button => button.click());
    await page.goto(`${origin}/login`);
    await page.getByLabel('Correo electrónico').fill(e.MYSTERY_SHOPPER_QA_EMAIL);
    await page.getByLabel('Contraseña').fill(e.MYSTERY_SHOPPER_QA_PASSWORD);
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await page.waitForURL(u => u.origin === origin && u.pathname.startsWith('/dashboard'));
    loggedIn = true;
    await page.goto(`${origin}/dashboard/long-form/configure/${id}`, { timeout: 120000 });
    await page.locator('input[type=radio][name=strategy][value=economical]').check();
    const details = page.getByText('Ver plan y costos detallados'); if (await details.isVisible()) await details.click();
    const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('dt')].map(dt => [dt.textContent.trim(), dt.nextElementSibling?.textContent?.trim()])));
    const raw = rows['Techo que se autorizaría'] ?? '', amount = /(?:USD|\$)\s*([0-9]+(?:[.,][0-9]+)?)/i.exec(raw);
    quote = amount && !/no cabe|sin verificar/i.test(raw) ? Number(amount[1].replace(',', '.')) : null;
    if (!(quote > 0 && quote <= 2) || rows['Imágenes generadas por IA'] !== '0' || rows['Clips de video IA'] !== '0' || await page.getByRole('button', { name: 'Confirmar y generar video', exact: true }).isDisabled()) throw Error('verified economical UI quote unavailable');
    allocationCheck(); await deployed(); await untouched();
    const ledger = await readTechnicalLedger(bucket), refusal = technicalReserveRefusal(ledger, key, quote);
    if (refusal || snapshotSha(ledger) !== allocation.ledgerBaselineSha256) throw Error(refusal ?? 'historical ledger changed from owner-approved snapshot');
    // A separate immutable one-shot fence prevents duplicate owner runs even after an ambiguous crash.
    const fence = await bucket.upload(`mystery-shopper/v3/receipts/technical-run-fence-${id}.json`, JSON.stringify({ requestId: id, reviewSha256: e.MS_ACCEPTED_REVIEW_SHA, allocationSha256: e.MS_ALLOCATION_RECEIPT_SHA, jobId }), { contentType: 'application/json', upsert: false });
    if (fence.error) throw Error('one-shot run already fenced');
    // The upload itself can have an unknown network outcome; record possible OPEN exposure before submitting it.
    receipt.reservationRetainedOpen = true; receipt.reservedUsd = quote;
    const reserved = await bucket.upload(`mystery-shopper/v3/ledger/reserve-${key}.json`, JSON.stringify({ key, module: 'youtube', jobId, reservedUsd: quote, at: new Date().toISOString() }), { contentType: 'application/json', upsert: false });
    if (reserved.error) throw Error('reservation failed; no retry');
    allowPaid = true;
    await page.getByRole('button', { name: 'Confirmar y generar video', exact: true }).click();
    await page.waitForURL(u => u.origin === origin && u.pathname === `/dashboard/videos/${id}`, { timeout: 180000 });
    allowPaid = false;
    if (receipt.status !== 'START_ACCEPTED' || receipt.renderPostCount !== 1 || receipt.confirmPostCount !== 1) throw Error('exact start proof absent');
    // All paid transitions stay blocked while the one accepted worker runs. No automatic resume/retry exists.
    const deadline = Date.now() + 60 * 60_000;
    while (Date.now() < deadline) {
      const row = await readRow(id);
      receipt.workerStatus = row.status; receipt.renderAttempts = row.render_attempts;
      if (row.render_attempts > 1) throw Error('unexpected additional worker attempt');
      if (['completed', 'failed'].includes(row.status)) { receipt.status = row.status === 'completed' ? 'COMPLETED_PENDING_PRIVATE_JOURNAL_QC' : 'FAILED_HOLD_RETAINED'; break; }
      await page.waitForTimeout(15000);
    }
  } finally {
    allowPaid = false; await browser.close();
    // No settlement here: even success needs independently verified closed-worker journal and native QC.
    const saved = await bucket.upload(`mystery-shopper/v3/receipts/technical-paid-run-${e.GITHUB_RUN_ID}.json`, JSON.stringify(receipt), { contentType: 'application/json', upsert: false, metadata: { status: receipt.status, reservationRetainedOpen: receipt.reservationRetainedOpen, confirmPostCount: receipt.confirmPostCount, renderPostCount: receipt.renderPostCount, noAutomaticRetry: true } });
    if (saved.error || receipt.status !== 'COMPLETED_PENDING_PRIVATE_JOURNAL_QC') process.exitCode = 1;
  }
}
main().catch(() => { console.error('Private operator run blocked or outcome uncertain. No retry; any reservation remains open.'); process.exitCode = 1; });
