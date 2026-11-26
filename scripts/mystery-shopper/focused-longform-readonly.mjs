import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { ORIGIN, allowedRequest, ownedCompleted } from './final-readonly-policy.mjs';
import { digestDelivery } from './readonly-media-stream.mjs';

async function main() {
  const env = process.env;
  const id = env.MS_EXISTING_LF_ID;
  const expectedSha = env.MS_EXPECTED_LF_SHA256;
  const productionCommit = env.MS_EXPECTED_PRODUCTION_COMMIT;
  const avId = env.MS_EXISTING_AV_ID;
  const avSha = env.MS_EXPECTED_AV_SHA256;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if ((avId || avSha) && (!uuid.test(avId ?? '') || !/^[0-9a-f]{64}$/.test(avSha ?? ''))) throw Error('invalid existing AV bindings');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id ?? '') || !/^[0-9a-f]{64}$/.test(expectedSha ?? '') || !/^[0-9a-f]{40}$/.test(productionCommit ?? '')) throw Error('invalid binding');
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','MYSTERY_SHOPPER_QA_EMAIL','MYSTERY_SHOPPER_QA_PASSWORD']) if (!env[key]) throw Error('bindings unavailable');
  const storageOrigin = new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin;
  const opts = {auth:{persistSession:false,autoRefreshToken:false}};
  const sb = createClient(storageOrigin, env.SUPABASE_SERVICE_ROLE_KEY, opts);
  const bucketInfo = await sb.storage.getBucket('videos');
  if (bucketInfo.error || bucketInfo.data.public !== false) throw Error('private storage required');
  const qa = createClient(storageOrigin, env.SUPABASE_SERVICE_ROLE_KEY, opts);
  const auth = await qa.auth.signInWithPassword({email:env.MYSTERY_SHOPPER_QA_EMAIL,password:env.MYSTERY_SHOPPER_QA_PASSWORD});
  if (auth.error || !auth.data.user) throw Error('QA identity unavailable');
  const rows = await sb.from('video_requests').select('id,user_id,status,render_attempts,mode').eq('id',id);
  if (rows.error || !ownedCompleted(rows.data,auth.data.user.id,[id]) || rows.data[0].render_attempts !== 1 || rows.data[0].mode !== 'long_form') throw Error('delivery not owned completed attempt one LF');
  if (avId) {
    const av = await sb.from('podcast_studio_episodes').select('id,user_id,status,mode,video_path').eq('id',avId).maybeSingle();
    if (av.error || av.data?.id !== avId || av.data.user_id !== auth.data.user.id || av.data.status !== 'ready' || av.data.mode !== 'avatar' || av.data.video_path !== `${auth.data.user.id}/podcast-studio/${avId}/episodio.mp4`) throw Error('existing AV not owned ready canonical episode');
  }
  const prefix = `mystery-shopper/private-focused-longform/${randomUUID()}`;
  const screens = []; const viewports = []; let delivery; let blockedRequests = 0; let checkpoint = 'browser-login';
  const browser = await chromium.launch({headless:true});
  async function capture(page, width, surface, locator) {
    const body = locator ? await locator.screenshot() : await page.screenshot({fullPage:true});
    const name = `${prefix}/screen-${screens.length}.png`;
    const saved = await sb.storage.from('videos').upload(name,body,{contentType:'image/png',upsert:false});
    if (saved.error) throw Error('private evidence unavailable');
    screens.push({width,surface,file:name,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});
  }
  async function receipt(passed) {
    const result = {version:1,passed,checkpoint,productionCommit,requestId:id,renderAttempt:1,existingAvId:avId ?? null,viewports,screens,delivery,blockedRequests,paidCalls:0,jobsCreated:0,createdAt:new Date().toISOString(),runId:env.GITHUB_RUN_ID};
    const saved = await sb.storage.from('videos').upload(`${prefix}/receipt.json`,JSON.stringify(result),{contentType:'application/json',upsert:false});
    if (saved.error) throw Error('private receipt unavailable');
  }
  try {
    for (const width of [390,412]) {
      checkpoint = 'browser-login';
      const context = await browser.newContext({viewport:{width,height:width === 390 ? 844 : 915},isMobile:true,hasTouch:true,serviceWorkers:'block'});
      let authenticated = false;
      await context.route('**/*', async route => {
        const req = route.request();
        const u = new URL(req.url());
        const exactExistingAvGet = authenticated && avId && req.method() === 'GET' && u.origin === ORIGIN && u.pathname === `/api/podcast/v3/${avId}`;
        if (!exactExistingAvGet && !allowedRequest(req.url(),req.method(),authenticated,storageOrigin)) { blockedRequests++; return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/login`);
      await page.getByLabel('Correo electrónico').fill(env.MYSTERY_SHOPPER_QA_EMAIL);
      await page.getByLabel('Contraseña').fill(env.MYSTERY_SHOPPER_QA_PASSWORD);
      await page.getByRole('button',{name:'Iniciar sesión',exact:true}).click();
      await page.waitForURL(url=>url.origin===ORIGIN && url.pathname.startsWith('/dashboard'),{timeout:30000});
      authenticated = true;
      checkpoint = 'library';
      const library = await page.goto(`${ORIGIN}/dashboard`,{waitUntil:'domcontentloaded'});
      if (library?.status() !== 200 || new URL(page.url()).pathname !== '/dashboard') throw Error('library navigation failed');
      checkpoint = 'actual-onboarding';
      const tour = page.getByTestId('onboarding-tour');
      if (!await tour.isVisible().catch(()=>false)) await page.getByRole('button',{name:'Ver cómo funciona Atomicvid',exact:true}).click();
      await tour.waitFor({state:'visible'});
      const dialog = tour.getByRole('dialog');
      if (await dialog.getAttribute('aria-modal') !== 'false') throw Error('onboarding still modal');
      const exit = page.getByRole('button',{name:'Cerrar sesión',exact:true});
      await exit.scrollIntoViewIfNeeded();
      const exitReachable = await exit.evaluate(el=>{const b=el.getBoundingClientRect();const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return !!hit&&(hit===el||el.contains(hit));});
      if (!exitReachable) throw Error('onboarding obscures exit');
      const onboarding = {visible:true,modal:false,exitReachable:true,source:'ACTUAL_AUTHENTICATED_UI_NOT_FIXTURE'};
      await capture(page,width,'actual-nonmodal-onboarding');
      await page.keyboard.press('Escape');
      await tour.waitFor({state:'hidden'});
      checkpoint = 'library';
      const card = page.locator(`a[href="/dashboard/videos/${id}"]`).first();
      await card.waitFor({state:'visible'});
      await capture(page,width,'library-existing-longform');
      checkpoint = 'completed-result';
      await card.click();
      await page.waitForURL(url=>url.origin===ORIGIN && url.pathname===`/dashboard/videos/${id}`);
      const body = await page.locator('body').innerText();
      if (/no encontramos esa página|No se pudo generar|Producción cancelada/i.test(body)) throw Error('delivery error UI');
      const video = page.locator('video').first();
      await video.waitFor();
      await video.evaluate(async v=>{v.muted=true;await v.play();});
      await page.waitForFunction(()=>{const v=document.querySelector('video');return v && v.currentTime>0 && v.videoWidth>0 && v.videoHeight>0;});
      const facts = await video.evaluate(v=>{v.pause();return {width:v.videoWidth,height:v.videoHeight,durationSeconds:v.duration,timeAdvancedSeconds:v.currentTime};});
      if (facts.durationSeconds < 180 || facts.durationSeconds > 181 || facts.width <= facts.height) throw Error('canonical repaired LF duration/dimensions mismatch');
      checkpoint = 'download';
      const href = await page.getByRole('link',{name:'Descargar video',exact:true}).getAttribute('href');
      if (!href) throw Error('download missing');
      // One full streamed digest per viewport; cookies never leave the application origin.
      const cookies = (await context.cookies(ORIGIN)).map(c=>`${c.name}=${c.value}`).join('; ');
      const downloaded = await digestDelivery(href,storageOrigin,cookies);
      if (downloaded.sha256 !== expectedSha || delivery && downloaded.bytes !== delivery.bytes) throw Error('canonical download digest mismatch');
      delivery = downloaded;
      await capture(page,width,'completed-longform-player-download');
      let avEpisode = null;
      if (avId) {
        checkpoint = 'existing-AV-library';
        const episodeResponse = page.waitForResponse(r=>r.request().method()==='GET' && new URL(r.url()).origin===ORIGIN && new URL(r.url()).pathname===`/api/podcast/v3/${avId}`,{timeout:30000}).then(response=>response,()=>null);
        const archived = await page.goto(`${ORIGIN}/dashboard/podcast?vista=archivados&mostrar=500#episodios`,{waitUntil:'domcontentloaded'});
        if (archived?.status() !== 200 || new URL(page.url()).pathname !== '/dashboard/podcast') throw Error('existing AV library unavailable');
        const card = page.getByTestId(`studio-episode-${avId}`);
        await card.waitFor({state:'visible'});
        const open = card.getByTestId(`studio-abrir-${avId}`);
        if (await open.isVisible().catch(()=>false)) await open.click();
        const response = await episodeResponse;
        if (!response || response.status() !== 200) throw Error('existing AV owner GET failed');
        const state = await response.json();
        if (state.episode?.id !== avId || state.episode.status !== 'ready' || state.episode.output !== 'video' || !state.video_url || !allowedRequest(state.video_url,'GET',true,storageOrigin)) throw Error('existing AV ready video unavailable');
        checkpoint = 'existing-AV-player';
        const player = card.getByTestId('studio-player');
        await player.waitFor({state:'visible'});
        await player.evaluate(async v=>{v.muted=true;await v.play();});
        await player.evaluate(async v=>{const deadline=Date.now()+30000;while(!(v.readyState>=2 && v.currentTime>0 && v.videoWidth>0)){if(Date.now()>deadline)throw Error('player timeout');await new Promise(r=>setTimeout(r,100));}});
        const media = await player.evaluate(v=>{v.pause();return {width:v.videoWidth,height:v.videoHeight,durationSeconds:v.duration,timeAdvancedSeconds:v.currentTime};});
        if (media.width !== 1920 || media.height !== 1080 || Math.abs(media.durationSeconds-57.759)>0.25) throw Error('existing AV media mismatch');
        checkpoint = 'existing-AV-streamed-download';
        const videoHref = await card.getByTestId('studio-download-mp4').getAttribute('href');
        if (!videoHref) throw Error('existing AV download unavailable');
        const avDelivery = await digestDelivery(videoHref,storageOrigin,cookies);
        if (avDelivery.sha256 !== avSha || avDelivery.bytes !== 4749264) throw Error('existing AV digest mismatch');
        avEpisode = {source:'AUTHENTIC_EXISTING_READY_AV_EPISODE_NOT_LANDING',player:media,delivery:avDelivery};
        await capture(page,width,'authentic-existing-AV-episode-player-download',card);
      }
      viewports.push({width,onboarding,libraryVisible:true,player:facts,downloadShaMatches:true,avEpisode});
      await context.close();
    }
    checkpoint = 'complete';
    await receipt(true);
    console.log('PASS: existing owned long-form library, mobile player and canonical streamed download; evidence private.');
  } catch {
    await receipt(false);
    throw Error('focused smoke incomplete');
  } finally { await browser.close(); }
}
main().catch(()=>{console.error('FAIL: focused read-only long-form smoke incomplete; diagnostics retained privately when available.');process.exitCode=1;});
