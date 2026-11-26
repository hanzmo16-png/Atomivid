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
  const audioId = env.MS_EXISTING_AUDIO_ID;
  if (!/^[0-9a-f-]{36}$/.test(audioId ?? '')) throw Error('existing audio binding required');
  const owner = login.data.user.id;
  const project = await sb.storage.from('videos').download(`audio-studio/v1/${owner}/${audioId}.json`);
  if (project.error || !project.data) throw Error('owned audio unavailable');
  const audioProject = JSON.parse(await project.data.text());
  const expectedHash = 'bde3a69d88f7980c0b319206f379ffd44fa91c179c123ea1d4faad79217d7c0e';
  if (audioProject.ownerId !== owner || audioProject.id !== audioId || audioProject.audio?.sha256 !== expectedHash || audioProject.audio?.bytes !== 4496877) throw Error('audio ownership/integrity mismatch');
  const prefix = `mystery-shopper/private-final-readonly/${randomUUID()}`;
  const receipts = []; const screens = []; let blocked = 0; let checkpoint = "browser-login";
  const browser = await chromium.launch({headless:true});
  try {
    for (const width of [390,412]) {
      const context = await browser.newContext({viewport:{width,height:width === 390 ? 844 : 915},isMobile:true,hasTouch:true,serviceWorkers:'block'});
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
      for (const route of ['/dashboard','/dashboard/long-form/new','/dashboard/new','/dashboard/podcast','/dashboard/audio-studio',`/dashboard/audio-studio/${audioId}`,...ids.map(id=>`/dashboard/videos/${id}`)]) {
        checkpoint = route.startsWith('/dashboard/videos/') ? 'completed-video' : route === `/dashboard/audio-studio/${audioId}` ? 'completed-audio' : 'module-navigation';
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
        if (route === `/dashboard/audio-studio/${audioId}`) {
          const audio = page.getByTestId('audio-player');
          await audio.waitFor();
          await audio.evaluate(async a => { a.muted=true; await a.play(); });
          await page.waitForFunction(() => { const a=document.querySelector('[data-testid=audio-player]'); return a && a.currentTime>0 && a.duration>180; });
          await audio.evaluate(a=>a.pause());
          const href = await page.getByRole('link',{name:'Descargar MP3',exact:true}).getAttribute('href');
          if (!href || !allowedRequest(new URL(href,ORIGIN).href,'GET',true,storageOrigin)) throw Error('unsafe audio delivery');
          const facts = await page.evaluate(async url => {
            const r=await fetch(url); const data=await r.arrayBuffer();
            const hash=await crypto.subtle.digest('SHA-256',data);
            return {ok:r.ok,bytes:data.byteLength,sha256:[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('')};
          },href);
          if (!facts.ok || facts.bytes !== 4496877 || facts.sha256 !== expectedHash) throw Error('audio download integrity mismatch');
        }
        const planQuotaVisible = route === '/dashboard/new' ? await page.getByTestId('plan-quota').isVisible().catch(()=>false) : undefined;
        if (planQuotaVisible === true) throw Error('internal QA quota note mismatch');
        screens.push({width,planQuotaVisible,planQuotaExpectation:route === '/dashboard/new'?'INTERNAL_ACCOUNT_NOTE_ABSENT':undefined,surface:route.startsWith('/dashboard/videos/')?'completed-video':route === `/dashboard/audio-studio/${audioId}`?'completed-audio':route.split('/').pop(),passed:true});
        const bytes = await page.screenshot({fullPage:true});
        const name = `${prefix}/screen-${receipts.length}.png`;
        const saved = await sb.storage.from('videos').upload(name,bytes,{contentType:'image/png',upsert:false});
        if (saved.error) throw Error('private evidence unavailable');
        receipts.push({sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
      }
      await context.close();
    }
  } catch {
    // Retain only safe progress metadata on failure; never serialize browser errors, bodies or URLs.
    await sb.storage.from('videos').upload(`${prefix}/receipt.json`,JSON.stringify({version:1,passed:false,checkpoint,screens,receipts,blockedRequests:blocked,paidCalls:0,jobsCreated:0,createdAt:new Date().toISOString()}),{contentType:'application/json',upsert:false});
    throw Error('private smoke incomplete');
  } finally { await browser.close(); }
  const receipt = {version:1,passed:true,runId:env.GITHUB_RUN_ID,productionCommit:env.MS_EXPECTED_PRODUCTION_COMMIT,coverage:{audio:"AUTHENTIC_EXISTING_MP3_PLAYBACK_FULL_SHA256",reel:"AUTHENTIC_EXISTING_COMPLETED_PLAYER_AND_DOWNLOAD_GET",oldLongForm:"AUTHENTIC_EXISTING_COMPLETED_PLAYER_AND_DOWNLOAD_GET",videoPodcast:"LANDING_NAVIGATION_ONLY_NOT_EPISODE_VERIFICATION"},screens,receipts,blockedRequests:blocked,paidCalls:0,jobsCreated:0,audioExistingMp3:'VERIFIED_PLAYBACK_AND_SHA256',createdAt:new Date().toISOString()};
  const saved = await sb.storage.from('videos').upload(`${prefix}/receipt.json`,JSON.stringify(receipt),{contentType:'application/json',upsert:false});
  if (saved.error) throw Error('receipt unavailable');
  console.log('PASS: authenticated mobile read-only checks; private evidence retained.');
}
main().catch(() => { console.error('FAIL: private read-only smoke incomplete; no private diagnostic output.'); process.exitCode=1; });
