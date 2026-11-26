/** Read-only browser quote for the reviewed operator QA row. No confirm or render requests allowed. */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { SOURCE_ID, ANCHOR_ID, prepareTechnicalRerender, verifiedReview, snapshotSha, reviewSummary } from './technical-long-form-rerender.ts';
const sanitized = value => String(value ?? '').replace(/https?:\/\/\S+/gi, '[URL]').replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '[UUID]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]').slice(0, 1800);

async function main() {
  const e = process.env;
  if (!e.GITHUB_RUN_ID || !/^mystery-shopper\/v3\/receipts\/technical-rerender-review-\d+\.json$/.test(e.MS_REVIEW_RECEIPT ?? '') || !/^[0-9a-f]{64}$/.test(e.MS_ACCEPTED_REVIEW_SHA ?? '')) throw Error('review required');
  const service = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = service.storage.from('videos'), privacy = await service.storage.getBucket('videos');
  if (privacy.error || privacy.data.public !== false) throw Error('privacy');
  const [source, anchor, target, output, review] = await Promise.all([
    service.from('video_requests').select('id,user_id,status,mode,duration_seconds,render_attempts,language,style,aspect_ratio,topic,script_json,video_path').eq('id', SOURCE_ID).single(),
    service.from('video_requests').select('user_id').eq('id', ANCHOR_ID).single(),
    service.from('video_requests').select('id,user_id,status,mode,duration_seconds,render_attempts,script_json,long_form_confirmed_at,long_form_production_plan,video_path').eq('id', e.MS_NEW_REQUEST_ID).single(),
    bucket.download(`${SOURCE_ID}/state/output.json`), bucket.download(e.MS_REVIEW_RECEIPT),
  ]);
  if (source.error || anchor.error || target.error || output.error || review.error) throw Error('source');
  const row = target.data;
  const plan = prepareTechnicalRerender(source.data, JSON.parse(await output.data.text()), row.user_id, anchor.data.user_id, e.MS_NEW_REQUEST_ID);
  verifiedReview(plan, JSON.parse(await review.data.text()), e.MS_ACCEPTED_REVIEW_SHA);
  const unstarted = r => r.id === e.MS_NEW_REQUEST_ID && r.user_id === source.data.user_id && r.status === 'script_ready' && r.mode === 'long_form' && r.duration_seconds === 180 && r.render_attempts === 0 && !r.long_form_confirmed_at && !r.long_form_production_plan && !r.video_path && snapshotSha(r.script_json) === plan.provenance.sourceScriptSha256;
  if (!unstarted(row)) throw Error('target changed');
  const browser = await chromium.launch({ headless: true });
  const receipt = { scope: 'OPERATOR_TECHNICAL_RERENDER_UI_QUOTE_ONLY', requestId: row.id, reviewSha256: plan.reviewSha256, customerFreshScriptFlowProved: false, confirmed: false, renderStarted: false, status: 'BLOCKED' };
  try {
    const origin = 'https://atomivid.vercel.app';
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    let authenticated = false;
    const blocked = [];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(request.method());
      const loginPost = !authenticated && url.origin === origin && url.pathname === '/login' && request.method() === 'POST';
      const paidProvider = /(^|\.)(anthropic\.com|openai\.com|elevenlabs\.io|heygen\.com|fal\.ai|fal\.run|runwayml\.com|recraft\.ai|beatoven\.ai|replicate\.com|did\.com|d-id\.com)$/.test(url.hostname);
      if (paidProvider || (!safeMethod && !loginPost)) {
        blocked.push({ method: request.method(), pathname: url.pathname });
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const page = await context.newPage();
    await page.addLocatorHandler(page.getByRole('button', { name: 'Omitir', exact: true }).first(), async button => { await button.click(); });
    await page.goto(`${origin}/login`);
    await page.getByLabel('Correo electrónico').fill(e.MYSTERY_SHOPPER_QA_EMAIL);
    await page.getByLabel('Contraseña').fill(e.MYSTERY_SHOPPER_QA_PASSWORD);
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await page.waitForURL(u => u.origin === origin && u.pathname.startsWith('/dashboard'), { timeout: 30000 });
    authenticated = true; // All browser mutations to every origin are now denied, including another login POST.
    await page.goto(`${origin}/dashboard/long-form/configure/${row.id}`, { timeout: 120000 });
    if (new URL(page.url()).pathname !== `/dashboard/long-form/configure/${row.id}`) throw Error('configuration access');
    const economy = page.locator('input[type=radio][name=strategy][value=economical]');
    if (await economy.count() !== 1) throw Error('economical strategy unavailable');
    await economy.check();
    const details = page.getByText('Ver plan y costos detallados');
    if (await details.isVisible()) await details.click();
    await page.waitForTimeout(1000);
    receipt.rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('dt')].map(dt => [dt.textContent.trim(), dt.nextElementSibling?.textContent?.trim()])));
    receipt.alerts = await page.getByRole('alert').allTextContents();
    receipt.confirmButtonDisabled = await page.getByRole('button', { name: 'Confirmar y generar video', exact: true }).isDisabled().catch(() => true);
    receipt.horizontalOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
    const text = receipt.rows['Techo que se autorizaría'] ?? '';
    const amount = /(?:USD|\$)\s*([0-9]+(?:[.,][0-9]+)?)/i.exec(text);
    receipt.ceilingUsd = amount && !/no cabe|sin verificar/i.test(text) ? Number(amount[1].replace(',', '.')) : null;
    receipt.quoteWithinTwoDollars = receipt.ceilingUsd !== null && receipt.ceilingUsd > 0 && receipt.ceilingUsd <= 2;
    receipt.zeroPaidAiVisuals = receipt.rows['Imágenes generadas por IA'] === '0' && receipt.rows['Clips de video IA'] === '0';
    receipt.blockedMutations = blocked;
    const after = await service.from('video_requests').select('id,user_id,status,mode,duration_seconds,render_attempts,script_json,long_form_confirmed_at,long_form_production_plan,video_path').eq('id', row.id).single();
    if (after.error || !unstarted(after.data)) throw Error('request changed during quote');
    const shot = await page.screenshot({ fullPage: true });
    const image = await bucket.upload(`mystery-shopper/v3/receipts/technical-rerender-quote-${e.GITHUB_RUN_ID}.png`, shot, { contentType: 'image/png', upsert: false });
    if (image.error) throw Error('private screenshot');
    receipt.status = receipt.quoteWithinTwoDollars && receipt.zeroPaidAiVisuals && !receipt.confirmButtonDisabled && !blocked.length ? 'PASS' : 'BLOCKED';
    if (receipt.status === 'BLOCKED') receipt.reason = receipt.confirmButtonDisabled ? 'UI confirmation button disabled; inspect actual alerts.' : blocked.length ? 'Browser blocked a mutation or paid-provider request.' : 'Quote or zero-paid-AI-visual requirement failed.';
  } catch (error) { receipt.reason = String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 600); }
  finally {
    await browser.close();
    const relevantRows = Object.fromEntries(Object.entries(receipt.rows ?? {}).filter(([key]) => /Guion ya gastado|Techo que se autorizaría|Costo estimado|Límite autorizado|Imágenes generadas|Clips de video IA|Reserva|Contingencia/i.test(key)).map(([key, value]) => [sanitized(key), sanitized(value)]));
    const saved = await bucket.upload(`mystery-shopper/v3/receipts/technical-rerender-quote-${e.GITHUB_RUN_ID}.json`, JSON.stringify(receipt), { contentType: 'application/json', upsert: false, metadata: { ...reviewSummary(plan), status: receipt.status, reason: sanitized(receipt.reason), confirmButtonDisabled: receipt.confirmButtonDisabled ?? null, blockedMutationCount: receipt.blockedMutations?.length ?? 0, alerts: (receipt.alerts ?? []).map(sanitized), relevantRows, ceilingUsd: receipt.ceilingUsd ?? null, quoteWithinTwoDollars: receipt.quoteWithinTwoDollars ?? false, zeroPaidAiVisuals: receipt.zeroPaidAiVisuals ?? false, confirmed: false, renderStarted: false } });
    if (saved.error || receipt.status !== 'PASS') process.exitCode = 1;
    console.log('UI quote recorded privately; no confirmation, reservation or generation.');
  }
}
main().catch(() => { console.error('Private quote blocked; no paid request was sent.'); process.exitCode = 1; });
