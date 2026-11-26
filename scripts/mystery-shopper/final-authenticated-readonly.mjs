import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { ORIGIN, allowedRequest, ownedCompleted } from './final-readonly-policy.mjs';
import {privateFailure,privatePathname} from './private-smoke-failure.mjs';

async function main() {
  const env = process.env;
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY']) if (!env[key]) throw Error('bindings');
  const storageOrigin = new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin;
  const sb = createClient(storageOrigin, env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
  const bucketInfo = await sb.storage.getBucket('videos');
  if (bucketInfo.error || bucketInfo.data.public !== false) throw Error('private storage required');
  const prefix = `mystery-shopper/private-final-readonly/${randomUUID()}`;
  const audioId=env.MS_EXISTING_AUDIO_ID;
  const expectedHash='bde3a69d88f7980c0b319206f379ffd44fa91c179c123ea1d4faad79217d7c0e';
  const receipts=[]; const screens=[]; const safePrechecks={}; const completedWidths=[];
  let browser; let activePage; let activeWidth; let blocked=0; let checkpoint='qa-bindings';
  async function saveReceipt(passed,failure) {
    const result={version:2,passed,runId:env.GITHUB_RUN_ID,productionCommit:env.MS_EXPECTED_PRODUCTION_COMMIT,requestedWidths:[390,412],completedWidths,checkpoint,width:activeWidth,safePrechecks,failure,screens,receipts,blockedRequests:blocked,paidCalls:0,jobsCreated:0,audioExistingMp3:passed?'VERIFIED_PLAYBACK_AND_SHA256':undefined,createdAt:new Date().toISOString(),coverage:{audio:'AUTHENTIC_EXISTING_MP3_PLAYBACK_FULL_SHA256',reel:'AUTHENTIC_EXISTING_COMPLETED_PLAYER_AND_DOWNLOAD_GET',oldLongForm:'AUTHENTIC_EXISTING_COMPLETED_PLAYER_AND_DOWNLOAD_GET',videoPodcast:'LANDING_NAVIGATION_ONLY_NOT_EPISODE_VERIFICATION'}};
    const saved=await sb.storage.from('videos').upload(`${prefix}/receipt.json`,JSON.stringify(result),{contentType:'application/json',upsert:false,metadata:result});
    if(saved.error)throw Error('private receipt unavailable');
  }
  try {
    for(const key of ['MYSTERY_SHOPPER_QA_EMAIL','MYSTERY_SHOPPER_QA_PASSWORD'])if(!env[key])throw Error('QA bindings unavailable');
  // Password grant uses the existing QA binding in memory only; no credential export.
  checkpoint='qa-authentication';
  const qa = createClient(storageOrigin, env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
  const login = await qa.auth.signInWithPassword({email:env.MYSTERY_SHOPPER_QA_EMAIL,password:env.MYSTERY_SHOPPER_QA_PASSWORD});
  if (login.error || !login.data.user) throw Error('QA identity unavailable');
  const ids = ['ed438c74-b0bb-43e1-8153-ea8c993d9877','c6264af5-e4ec-8c36-9b9a-946bd4b09c03'];
  checkpoint='existing-deliveries-owner-status';
  const rows = await sb.from('video_requests').select('id,user_id,status').in('id',ids);
  safePrechecks.existingDeliveries=rows.data?.map(r=>({id:r.id,ownerMatch:r.user_id===login.data.user.id,completed:r.status==='completed'}));
  if (rows.error || !ownedCompleted(rows.data,login.data.user.id,ids)) throw Error('existing deliveries not owned/completed');
  checkpoint='audio-binding';
  if (!/^[0-9a-f-]{36}$/.test(audioId ?? '')) throw Error('existing audio binding required');
  const owner = login.data.user.id;
  checkpoint='audio-project-download';
  const project = await sb.storage.from('videos').download(`audio-studio/v1/${owner}/${audioId}.json`);
  if (project.error || !project.data) throw Error('owned audio unavailable');
  checkpoint='audio-project-parse';
  const audioProject = JSON.parse(await project.data.text());
  checkpoint='audio-project-owner-integrity';
  const allowedFields=['id','ownerId','user_id','project','data','audio','output','version','generation','scriptJob','createdAt','updatedAt','revision','archivedAt','status','title','script','notes','music','voices','ttsModel','targetMinutes','voiceCount','language'];
  safePrechecks.audioProject={fieldNames:Object.keys(audioProject ?? {}).filter(k=>allowedFields.includes(k)),idMatch:audioProject?.id===audioId,ownerMatch:audioProject?.ownerId===owner,audioPresent:!!audioProject?.audio,audioFieldNames:Object.keys(audioProject?.audio ?? {}).filter(k=>['sha256','bytes','path','revision','durationSeconds','renderedAt','provider','model','segments'].includes(k)),sha256:typeof audioProject?.audio?.sha256==='string'&&/^[0-9a-f]{64}$/.test(audioProject.audio.sha256)?audioProject.audio.sha256:undefined,bytes:Number.isFinite(audioProject?.audio?.bytes)?audioProject.audio.bytes:undefined};
  if (audioProject.ownerId !== owner || audioProject.id !== audioId || audioProject.audio?.sha256 !== expectedHash || audioProject.audio?.bytes !== 4496877) throw Error('audio ownership/integrity mismatch');
    checkpoint='browser-launch';
    browser=await chromium.launch({headless:true});
    for (const width of [390,412]) {
      activeWidth=width;checkpoint="browser-login";
      const context = await browser.newContext({viewport:{width,height:width === 390 ? 844 : 915},isMobile:true,hasTouch:true,serviceWorkers:'block'});
      let authenticated = false;
      await context.route('**/*', async route => {
        const req = route.request();
        if (!allowedRequest(req.url(),req.method(),authenticated,storageOrigin)) { blocked++; return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage();activePage=page;
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
        receipts.push({file:name,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
      }
      completedWidths.push(width);
      await context.close();activePage=undefined;
    }
    checkpoint='complete';
    await saveReceipt(true);
  } catch(error) {
    const failure={...privateFailure(error,[env.SUPABASE_SERVICE_ROLE_KEY,env.MYSTERY_SHOPPER_QA_EMAIL,env.MYSTERY_SHOPPER_QA_PASSWORD,env.NEXT_PUBLIC_SUPABASE_URL]),checkpoint,width:activeWidth,pathname:privatePathname(activePage?.url?.(),ORIGIN)};
    try {
      if(activePage){
        const bytes=await activePage.screenshot({fullPage:true,timeout:5000});
        const file=`${prefix}/failure-${activeWidth}.png`;
        const saved=await sb.storage.from('videos').upload(file,bytes,{contentType:'image/png',upsert:false});
        if(saved.error)throw Error('private failure screenshot unavailable');
        failure.screenshot=file;
      }
    }catch{failure.screenshotUnavailable=true;}
    await saveReceipt(false,failure);
    throw Error('private smoke incomplete');
  } finally { await browser?.close(); }
  console.log('PASS: authenticated mobile read-only checks; private evidence retained.');
}
main().catch(() => { console.error('FAIL: private read-only smoke incomplete; no private diagnostic output.'); process.exitCode=1; });
