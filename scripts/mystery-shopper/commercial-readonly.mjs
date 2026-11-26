import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { ORIGIN, allowedCommercialRequest, commercialVisibility } from './commercial-policy.mjs';

async function main() {
  const env = process.env;
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'MYSTERY_SHOPPER_QA_EMAIL', 'MYSTERY_SHOPPER_QA_PASSWORD']) {
    if (!env[key]) throw Error('bindings unavailable');
  }
  const storageOrigin = new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin;
  const sb = createClient(storageOrigin, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = await sb.storage.getBucket('videos');
  if (bucket.error || bucket.data.public !== false) throw Error('private storage required');
  const prefix = `mystery-shopper/private-commercial-readonly/${randomUUID()}`;
  const receipt = {
    version: 1, passed: false, checkpoint: 'public-signup', checks: [], screens: [],
    blockedRequests: 0, paidCalls: 0, jobsCreated: 0, accountsCreated: 0,
    limitations: ['No signup submission or email confirmation', 'No checkout, payment, subscription change or customer portal', 'Credit amounts and account text are not exported', 'One existing QA account does not prove every customer entitlement'],
  };
  const record = (name, passed, width) => {
    receipt.checks.push({ name, passed: !!passed, width });
    if (!passed) throw Error('commercial assertion failed');
  };
  const save = async (page, width, surface) => {
    const bytes = await page.screenshot({ fullPage: true });
    const name = `screen-${receipt.screens.length}.png`;
    const result = await sb.storage.from('videos').upload(`${prefix}/${name}`, bytes, { contentType: 'image/png', upsert: false });
    if (result.error) throw Error('private evidence unavailable');
    receipt.screens.push({ name, width, surface, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  const persist = async () => {
    const result = await sb.storage.from('videos').upload(`${prefix}/receipt.json`, JSON.stringify({ ...receipt, createdAt: new Date().toISOString() }), { contentType: 'application/json', upsert: false, metadata: { passed: receipt.passed, checkpoint: receipt.checkpoint, checks: receipt.checks, screenCount: receipt.screens.length } });
    if (result.error) throw Error('private receipt unavailable');
  };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 412]) {
      const context = await browser.newContext({ viewport: { width, height: 915 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      let phase = 'public';
      await context.route('**/*', route => {
        const request = route.request();
        if (!allowedCommercialRequest(request.url(), request.method(), phase, storageOrigin)) {
          receipt.blockedRequests++;
          return route.abort();
        }
        return route.continue();
      });
      // Tour dismissal is local to this ephemeral browser; no account preference is changed.
      await context.addInitScript(() => localStorage.setItem('atomivid_onboarding_completed_v1', '1'));
      const page = await context.newPage();
      let consoleErrors = 0, pageErrors = 0;
      page.on('console', message => { if (message.type() === 'error') consoleErrors++; });
      page.on('pageerror', () => { pageErrors++; });
      if (env.COMMERCIAL_AUTHENTICATED_ONLY !== '1' && env.COMMERCIAL_BILLING_ONLY !== '1') {
        receipt.checkpoint = 'public-signup';
        const signup = await page.goto(`${ORIGIN}/register`, { waitUntil: 'networkidle' });
        record('signup-form-public-get', signup?.status() === 200 && new URL(page.url()).pathname === '/register', width);
        const validation = await page.evaluate(() => {
          const email = document.querySelector('input[name=email]');
          const password = document.querySelector('input[name=password]');
          const form = email?.form;
          if (!email || !password || !form) return null;
          const facts = { emailRequired: email.required && email.type === 'email', passwordRequired: password.required && password.minLength >= 6, emptyRejected: !form.checkValidity() };
          email.value = 'not-an-email'; password.value = 'abcdef';
          facts.invalidEmailRejected = !email.checkValidity();
          email.value = 'qa-form-only@example.invalid'; password.value = 'x';
          // minlength applies to user input; the attribute is checked above, with no submit or synthetic request.
          email.value = ''; password.value = '';
          return facts;
        });
        record('signup-browser-required-email-password-validation-no-submit', validation && Object.values(validation).every(Boolean), width);
        record('signup-terms-privacy-links', await page.locator('a[href="/terms"]').count() > 0 && await page.locator('a[href="/privacy"]').count() > 0, width);
        await save(page, width, 'public-signup');

      }

      receipt.checkpoint = 'existing-qa-login';
      phase = 'login';
      await page.goto(`${ORIGIN}/login`);
      await page.getByLabel('Correo electrónico').fill(env.MYSTERY_SHOPPER_QA_EMAIL);
      await page.getByLabel('Contraseña').fill(env.MYSTERY_SHOPPER_QA_PASSWORD);
      await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
      await page.waitForURL(url => url.origin === ORIGIN && url.pathname === '/dashboard', { timeout: 30000 });
      phase = 'authenticated';
      await page.waitForLoadState('networkidle');
      receipt.checkpoint = 'dashboard-commercial-navigation';
      const existingDetail = page.locator('a[href^="/dashboard/videos/"]').first();
      const detailHref = await existingDetail.getAttribute('href');
      if (!/^\/dashboard\/videos\/[0-9a-f-]{36}$/.test(detailHref ?? '')) throw Error('safe existing delivery required');
      let dashboardCommercial = null;
      if (env.COMMERCIAL_BILLING_ONLY !== '1') {
        record('single-cosmos2-background-preserved', await page.locator('[data-testid=fondo-video]').count() === 1 && await page.locator('[data-testid=cinematic-video]').count() === 0, width);
        const dock = page.getByTestId('mobile-dock');
        record('mobile-dock-visible', await dock.isVisible(), width);
        record('library-link-resolves-existing-projects-anchor', await dock.getByRole('link', { name: 'Biblioteca', exact: true }).getAttribute('href') === '/dashboard#proyectos' && await page.locator('#proyectos').count() === 1, width);
        await dock.getByRole('link', { name: 'Biblioteca', exact: true }).click();
        // Next Link updates the URL asynchronously; retain the exact path/hash contract after it settles.
        await page.waitForURL(url => url.origin === ORIGIN && url.pathname === '/dashboard' && url.hash === '#proyectos', { timeout: 10000 });
        record('library-navigation-is-current-dashboard-anchor', new URL(page.url()).pathname === '/dashboard' && new URL(page.url()).hash === '#proyectos', width);
        record('existing-library-detail-link-present', await existingDetail.count() === 1, width);
        record('existing-library-detail-is-same-origin-uuid-route', /^\/dashboard\/videos\/[0-9a-f-]{36}$/.test(detailHref ?? ''), width);
        record('mobile-no-horizontal-overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width);
        dashboardCommercial = commercialVisibility(await page.locator('body').innerText());
        await save(page, width, 'library-navigation');

      }

      receipt.checkpoint = 'billing-visible-state';
      await page.getByRole('link', { name: 'Mi plan', exact: true }).click();
      await page.waitForURL(url => url.origin === ORIGIN && url.pathname === '/dashboard/billing');
      await page.getByRole('heading', { name: /^(Facturación|Tu plan de producción)$/ }).waitFor();
      const billingCommercial = commercialVisibility(await page.locator('body').innerText());
      receipt.checks.push({ name: 'commercial-visible-state-classification', width, dashboard: dashboardCommercial, billing: billingCommercial });
      record('billing-renders-plan-state-or-available-plans', billingCommercial.currentPlanVisible || billingCommercial.planOptionsVisible, width);
      record('billing-mobile-dock-stays-available', await page.getByTestId('mobile-dock').isVisible(), width);
      record('billing-no-horizontal-overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width);

      await save(page, width, 'billing-visible-state');

      receipt.checkpoint = 'existing-library-download';
      const detailResponse = await page.goto(`${ORIGIN}${detailHref}`, { waitUntil: 'networkidle' });
      record('existing-detail-navigation', detailResponse?.status() === 200 && new URL(page.url()).pathname === detailHref, width);
      const download = page.getByRole('link', { name: 'Descargar video', exact: true });
      const href = await download.getAttribute('href');
      record('existing-download-link-safe-and-visible', await download.isVisible() && href && allowedCommercialRequest(new URL(href, ORIGIN).href, 'GET', phase, storageOrigin), width);
      // Existing delivery only: a small GET Range proves the shown download is accessible without generation.
      const downloaded = await page.evaluate(async url => {
        const response = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
        return { ok: response.ok, bytes: (await response.arrayBuffer()).byteLength };
      }, href);
      record('existing-download-get-returns-bytes', downloaded.ok && downloaded.bytes > 0, width);
      receipt.checks.push({ name: 'browser-error-counts', width, consoleErrors, pageErrors });
      record('no-unhandled-browser-errors', pageErrors === 0, width);
      await save(page, width, 'existing-download');
      await context.close();
    }
    receipt.passed = true;
    receipt.checkpoint = 'complete';
    await persist();
  } catch {
    await persist();
    throw Error('commercial read-only incomplete');
  } finally {
    await browser.close();
  }
  console.log('PASS: focused commercial read-only verification; private evidence retained. No signup submission, payments or generation.');
}

main().catch(() => { console.error('FAIL: commercial read-only verification incomplete; private diagnostics retained.'); process.exitCode = 1; });
