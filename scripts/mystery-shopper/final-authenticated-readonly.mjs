import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { ORIGIN, allowedRequest, ownedCompleted } from './final-readonly-policy.mjs';

async function main() {
  const env = process.env;
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','MYSTERY_SHOPPER_QA_EMAIL','MYSTERY_SHOPPER_QA_PASSWORD']) if (!env[key]) throw Error('bindings');
  const storageOrigin = new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin;
  const sb = createClient(storageOrigin, env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
  const bucketInfo = await sb.storage.getBucket('videos');
  if (bucketInfo.error || bucketInfo.data.public !== false) throw Error('private storage required');
  // Password grant uses the existing QA binding in memory only; no credential export.
  const qa = createClient(storageOrigin, env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
  const login = await qa.auth.signInWithPassword({email:env.MYSTERY_SHOPPER_QA_EMAIL,password:env.MYSTERY_SHOPPER_QA_PASSWORD});
  if (login.error || !login.data.user) throw Error('QA identity unavailable');
  const ids = ['ed438c74-b0bb-43e1-8153-ea8c993d9877','c6264af5-e4ec-8c36-9b9a-946bd4b09c03'];
  const rows = await sb.from('video_requests').select('id,user_id,status').in('id',ids);
  if (rows.error || !ownedCompleted(rows.data,login.data.user.id,ids)) throw Error('existing deliveries not owned/completed');
  const prefix = `mystery-shopper/private-final-readonly/${randomUUID()}`;
  const receipts = []; const screens = []; let blocked = 0;
  const browser = await chromium.launch({headless:true});
  try {
    for (const width of [390,412]) {
      const context = await browser.newContext({viewport:{width,height:915},isMobile:true,hasTouch:true,serviceWorkers:'block'});
      let authenticated = false;
      await context.route('**/*', async route => {
        const req = route.request();
        if (!allowedRequest(req.url(),req.method(),authenticated,storageOrigin)) { blocked++; return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/login`);
      await page.getByLabel('Correo electrónico').fill(env.MYSTERY_SHOPPER_QA_EMAIL);
      await page.getByLabel('Contraseña').fill(env.MYSTERY_SHOPPER_QA_PASSWORD);
      await page.getByRole('button',{name:'Iniciar sesión',exact:true}).click();
      await page.waitForURL(url => url.origin === ORIGIN && url.pathname.startsWith('/dashboard'),{timeout:30000});
      authenticated = true;
      for (const route of ['/dashboard','/dashboard/long-form/new','/dashboard/new','/dashboard/podcast','/dashboard/audio-studio',...ids.map(id=>`/dashboard/videos/${id}`)]) {
        const response = await page.goto(`${ORIGIN}${route}`,{waitUntil:'domcontentloaded'});
        if (response?.status() !== 200 || new URL(page.url()).origin !== ORIGIN || new URL(page.url()).pathname !== route) throw Error('navigation failed');
        const body = await page.locator('body').innerText();
        if (/no encontramos esa página/i.test(body)) throw Error('missing surface');
        if (route.startsWith('/dashboard/videos/')) {
          const video = page.locator('video').first();
          await video.waitFor();
          await video.evaluate(async v => { v.muted=true; await v.play(); });
          await page.waitForFunction(() => { const v=document.querySelector('video'); return v && v.currentTime>0 && v.videoWidth>0; });
          await video.evaluate(v=>v.pause());
          const link = page.getByRole('link',{name:'Descargar video',exact:true});
          const href = await link.getAttribute('href');
          if (!href || !allowedRequest(new URL(href,ORIGIN).href,'GET',true,storageOrigin)) throw Error('unsafe delivery');
          // Browser fetch passes through the same guard; Range avoids downloading a documentary twice.
          const downloaded = await page.evaluate(async url => { const r=await fetch(url,{headers:{Range:'bytes=0-1023'}}); return {ok:r.ok,bytes:(await r.arrayBuffer()).byteLength}; },href);
          if (!downloaded.ok || !downloaded.bytes) throw Error('download failed');
        }
        screens.push({width,surface:route.startsWith('/dashboard/videos/')?'completed-video':route.split('/').pop(),passed:true});
        const bytes = await page.screenshot({fullPage:true});
        const name = `${prefix}/screen-${receipts.length}.png`;
        const saved = await sb.storage.from('videos').upload(name,bytes,{contentType:'image/png',upsert:false});
        if (saved.error) throw Error('private evidence unavailable');
        receipts.push({sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
      }
      await context.close();
    }
  } finally { await browser.close(); }
  const receipt = {version:1,passed:true,screens,receipts,blockedRequests:blocked,paidCalls:0,jobsCreated:0,audioExistingMp3:'NOT_VERIFIED',createdAt:new Date().toISOString()};
  const saved = await sb.storage.from('videos').upload(`${prefix}/receipt.json`,JSON.stringify(receipt),{contentType:'application/json',upsert:false});
  if (saved.error) throw Error('receipt unavailable');
  console.log('PASS: authenticated mobile read-only checks; private evidence retained.');
}
main().catch(() => { console.error('FAIL: private read-only smoke incomplete; no private diagnostic output.'); process.exitCode=1; });
