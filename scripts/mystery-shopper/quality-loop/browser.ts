/** Reuses Mystery Shopper observation and detection. No jobStore, service role, ledger, or paid runner. */
import { findingsFrom, technicalTerms, type PageMetrics } from '../../../src/lib/mystery-shopper/live';
import { inspectCampaign320SurfaceReadOnly } from '../../../src/lib/mystery-shopper/v3/campaign-320-readonly-preflight';
import { classifyAuth } from '../../../src/lib/mystery-shopper/v3/auth-outcome';
import { allowBrowserRequest, sentinelStatus, targetOrigin, providerReadiness, allowMediaProbe } from '../../../src/lib/mystery-shopper/quality-loop/policy';
import { sampleMedia } from './media';
import { smoke } from '../smoke';
import { PRODUCTS, type Cycle, type Check } from '../../../src/lib/mystery-shopper/quality-loop/model';
// Playwright remains a worker-only dependency, just like the existing Mystery Shopper worker.
export async function observe(env: Record<string,string|undefined>, input: Pick<Cycle,'id'|'trigger'|'runnerSha'|'url'>, stopped: () => Promise<boolean> = async () => false): Promise<Cycle> {
  const fixture=env.AQL_FIXTURE==='1', origin=targetOrigin(env.MS_TARGET_URL||'https://atomivid.vercel.app',fixture);
  const startedAt=new Date().toISOString();const checks:Check[]=[];
  const add=(c:Check)=>checks.push(c);
  let authenticated=false, sha:string|null=null, sentinel:Cycle['sentinel']='BLOCKED';
  const finish=():Cycle=>({...input,scope:fixture?'fixture':'authenticated-readonly',startedAt,finishedAt:new Date().toISOString(),sha,authenticated,sentinel,checks,spendUsd:0});
  const anonymous=await smoke(origin);
  for(const c of anonymous.checks)add({id:`anonymous-${c.name}`,product:'account-nav',state:c.pass?'PASS':'FAIL',severity:'P1',owner:'codex',module:'permissions',detail:`${c.name}: HTTP ${c.status}`});
  if(!env.MYSTERY_SHOPPER_QA_EMAIL||!env.MYSTERY_SHOPPER_QA_PASSWORD){
    for(const product of PRODUCTS)add({id:'qa-auth',product,state:'BLOCKED',severity:'P1',owner:'codex',module:'auth',detail:'QA bindings unavailable; no login attempted'});
    return finish();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pw=await import(env.PLAYWRIGHT_MODULE||'playwright') as any;
  const browser=await pw.chromium.launch({headless:true,executablePath:env.MS_CHROME||undefined});
  try {
    const context=await browser.newContext({baseURL:origin,viewport:{width:412,height:915},isMobile:true,hasTouch:true,locale:'es-MX',serviceWorkers:'block'});
    let blockedRequests=0;
    await context.routeWebSocket('**/*',(ws:{close():void})=>ws.close());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await context.route('**/*',async(route:any)=>{
      const r=route.request();
      if(!allowBrowserRequest({url:r.url(),method:r.method(),origin,authenticated,resourceType:r.resourceType()})){blockedRequests++;return route.abort();}
      if(!fixture && r.method()==='POST' && r.url()===`${origin}/login` && await stopped())return route.abort();
      return route.continue();
    });
    // Kill switch is reread between products by the runner callback, never supplied by page content.
    const page=await context.newPage();page.setDefaultTimeout(10000);
    await page.goto('/login',{waitUntil:'domcontentloaded',timeout:30000});
    await page.getByLabel('Correo electrónico').fill(env.MYSTERY_SHOPPER_QA_EMAIL);
    await page.getByLabel('Contraseña').fill(env.MYSTERY_SHOPPER_QA_PASSWORD);
    await page.getByRole('button',{name:'Iniciar sesión',exact:true}).click();
    await page.waitForURL((u:URL)=>/^\/dashboard(?:\/|$)/.test(u.pathname)||u.searchParams.has('error'),{timeout:30000}).catch(()=>{});
    const outcome=classifyAuth({hasEmail:true,hasPassword:true,finalUrl:page.url(),alertText:await page.locator('[role="alert"]').first().innerText().catch(()=>''),timedOut:false});
    authenticated=outcome.kind==='ok';
    add({id:'qa-auth',product:'account-nav',state:authenticated?'PASS':outcome.state==='BLOCKED'?'BLOCKED':'FAIL',severity:'P1',owner:'codex',module:'auth',detail:authenticated?'Fresh QA browser login confirmed':'QA login unsuccessful; credentials and response omitted'});
    if(!authenticated)return finish();
    const getJSON=async(p:string)=>page.evaluate(async(p:string)=>{try{const r=await fetch(p,{cache:'no-store',signal:AbortSignal.timeout(15000)});return {status:r.status,data:await r.json()};}catch{return {status:0,data:null};}},p);
    const build=await getJSON('/api/build-info');
    if(build.status===200&&/^[a-f0-9]{40}$/.test(build.data?.sha))sha=build.data.sha;
    add({id:'deployed-sha',product:'account-nav',state:sha?'PASS':'BLOCKED',severity:'P1',owner:'codex',module:'deployment',detail:sha?'SHA returned by the evaluated application':'Evaluated application SHA unavailable; runner SHA is not production identity'});
    if(env.AQL_EXPECTED_SHA && sha!==env.AQL_EXPECTED_SHA)add({id:'deployment-sha-match',product:'account-nav',state:'FAIL',severity:'P1',owner:'codex',module:'deployment',detail:'Deployment event SHA does not match evaluated application'});
    const sent=await getJSON('/api/command-center/resource-sentinel');sentinel=sentinelStatus(sent.status,sent.data);
    add({id:'sentinel-read',product:'command-center',state:sentinel==='READ'?'PASS':'BLOCKED',severity:'P1',owner:'codex',module:'sentinel',detail:sentinel==='READ'?'Existing Resource Sentinel read successfully; private balances omitted':'Sentinel not deployed, unavailable or QA lacks admin access; provider-dependent checks blocked'});
    // Only operational statuses leave this process; never provider balances or private financial rows.
    for(const product of PRODUCTS){
      const good=sentinel==='READ'&&providerReadiness(product,sent.data);
      add({id:'provider-readiness',product,state:good?'PASS':'BLOCKED',severity:'P1',owner:'codex',module:'sentinel',detail:good?'Readiness observed only; paid tests remain prohibited':'Provider capacity, balances, reservations or worker coverage unverified; no provider calls made'});
    }
    const routes=[{product:'youtube',path:'/dashboard/long-form/new'},{product:'reels',path:'/dashboard/new?formato=reel'},{product:'audio-podcast',path:'/dashboard/audio-studio'},{product:'video-podcast',path:'/dashboard/podcast'},{product:'library',path:'/dashboard'},{product:'commercial',path:'/dashboard/billing'}] as const;
    for(const viewport of [{width:412,height:915},{width:1440,height:900}]){
      await page.setViewportSize(viewport);
      for(const route of routes){
        if(await stopped())throw new Error('STOPPED');
        const product=route.product==='library'?'account-nav':route.product;
        const t=Date.now();let status:number|null=null;
        try{
          const response=await page.goto(route.path,{waitUntil:'domcontentloaded',timeout:30000});status=response?.status()??null;
          await page.locator('h1,[data-testid="podcast-wizard"]').first().waitFor({state:'visible',timeout:12000}).catch(()=>{});
          const finalPath=new URL(page.url()).pathname;
          const redirected=finalPath==='/login',denied=status===404||status===403;
          add({id:`route-${route.product}-${viewport.width}`,product,state:redirected||status===null||(status>=500)?'FAIL':denied?'BLOCKED':'PASS',severity:redirected?'P0':'P1',owner:'codex',module:'navigation',detail:`Route ${route.path.split('?')[0]}: HTTP ${status}; authenticated=${!redirected}`});
          if(redirected||denied||!status||status>=500)continue;
          const metrics=await page.evaluate(()=>{
            const controls=[...document.querySelectorAll('button,a,input,select,textarea')].filter(e=>e.getBoundingClientRect().height>0);
            return {horizontalOverflowPx:Math.max(0,document.documentElement.scrollWidth-innerWidth),smallTargets:controls.filter(e=>e.getBoundingClientRect().height<44).length,unlabeledFields:[...document.querySelectorAll('input:not([type=hidden]),textarea,select')].filter(e=>!e.getAttribute('aria-label')&&!e.getAttribute('aria-labelledby')&&!(e as HTMLInputElement).labels?.length).length,terms:document.body.innerText.slice(0,10000),progress:[...document.querySelectorAll('[role=progressbar]')].map(e=>Number(e.getAttribute('aria-valuenow')))};
          });
          const pm:PageMetrics={url:origin+route.path,viewport,horizontalOverflowPx:metrics.horizontalOverflowPx,smallTargets:metrics.smallTargets,unlabeledFields:metrics.unlabeledFields,technicalTerms:technicalTerms(metrics.terms),costVisible:/crédito|costo|presupuesto|saldo/i.test(metrics.terms),errorsVisible:[],consoleErrors:0,loadMs:Date.now()-t,httpStatus:status};
          const f=findingsFrom(route.product==='youtube'?'long-form':route.product==='library'?'library':route.product==='commercial'?'account-nav':route.product,'profesional',[pm],[],[]);
          add({id:`layout-${route.product}-${viewport.width}`,product,state:f.some(x=>x.severity==='P1'||x.severity==='P2')?'FAIL':'PASS',severity:viewport.width<500?'P1':'P2',owner:'claude',module:'ui',detail:`overflow=${pm.horizontalOverflowPx}px; unlabeled=${pm.unlabeledFields}; targets<44=${pm.smallTargets}`});
          add({id:`progress-${route.product}-${viewport.width}`,product,state:metrics.progress.length?(metrics.progress.every((n:number)=>Number.isFinite(n)&&n>=0&&n<=100)?'PASS':'FAIL'):'SKIP',severity:'P2',owner:'codex',module:'progress',detail:metrics.progress.length?'Observed progress bounds checked':'No active job shown; no generation or recovery started'});
          if(route.product==='reels'||route.product==='video-podcast'){
            const inspection=await inspectCampaign320SurfaceReadOnly(page,route.product);
            add({id:`controls-${route.product}-${viewport.width}`,product:route.product,state:inspection.observation.generationBlocked?'BLOCKED':Object.values(inspection.observation.requiredVisible).every(Boolean)?'PASS':'FAIL',severity:'P1',owner:'claude',module:'ui',detail:`Readonly controls: ${Object.entries(inspection.observation.requiredVisible).map(([name,present])=>`${name}=${present?'present':'missing'}`).join('; ')}`});
          }
          if(route.product==='audio-podcast'||route.product==='youtube')add({id:`configuration-${route.product}-${viewport.width}`,product:route.product,state:await page.locator('input,select,textarea,button').count()>0?'PASS':'FAIL',severity:'P1',owner:'claude',module:'ui',detail:'Configuration controls visible; language/voice changes that persist are reserved for isolated tests'});
          // Observe existing player/download controls without an unbounded media request.
          if(PRODUCTS.includes(route.product as never)){
            const count=await page.locator('audio[src],video[src]').count();
            add({id:`player-visible-${route.product}-${viewport.width}`,product:route.product as typeof PRODUCTS[number],state:count?'PASS':'BLOCKED',severity:'P1',owner:'codex',module:'delivery',detail:count?'Existing media element observed; no new production':'No existing player on this screen; asset search runs separately'});
          }
        }catch{add({id:`route-${route.product}-${viewport.width}-error`,product,state:'FAIL',severity:'P1',owner:'codex',module:'navigation',detail:'Navigation/observation failed; raw authenticated body omitted'});}
      }
    }
    // One bounded sample per product per cycle: <=1MiB total payload, no provider or SDK request.
    for(const product of PRODUCTS){
      if(await stopped())throw new Error('STOPPED');
      if(!allowMediaProbe(input.trigger,fixture)){
        for(const id of ['download-sample','playback-sample','full-file-integrity'])add({id,product,state:'BLOCKED',severity:'P1',owner:'codex',module:'delivery',detail:'Recurring production media payload read not executed: free egress quota unverified; isolated fixtures remain available'});
        continue;
      }
      let assetPage=product==='audio-podcast'?'/dashboard/audio-studio':product==='video-podcast'?'/dashboard/podcast':null;
      if(!assetPage){
        await page.goto('/dashboard',{waitUntil:'domcontentloaded'});
        assetPage=await page.evaluate((product:string)=>{
          const links=[...document.querySelectorAll<HTMLAnchorElement>('a[href^="/dashboard/videos/"]')];
          return links.find(a=>{const card=a.closest('div.rounded-lg');const text=card?.textContent||'';return product==='youtube'?/Documental/.test(text):!(/Documental|Avatar/.test(text));})?.getAttribute('href')||null;
        },product);
      }
      if(!assetPage){add({id:'existing-asset',product,state:'BLOCKED',severity:'P1',owner:'codex',module:'delivery',detail:'No existing QA asset for this product; never manufactured'});continue;}
      try{
        await page.goto(assetPage,{waitUntil:'domcontentloaded'});
        const src=await page.locator(product==='audio-podcast'?'audio[src]':'video[src]').first().getAttribute('src',{timeout:5000});
        if(!src)throw new Error('NO_MEDIA');
        const cookie=(await context.cookies(origin)).map((c:{name:string,value:string})=>`${c.name}=${c.value}`).join('; ');
        const sample=await sampleMedia(src,origin,cookie);
        add({id:'download-sample',product,state:'PASS',severity:'P1',owner:'codex',module:'delivery',detail:`Existing authorized asset GET sample: ${sample.bytes} bytes; signed URL/private name omitted`});
        const playable=await page.evaluate(async({base64,mime}:{base64:string,mime:string})=>{
          const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:mime}));const media=document.createElement(mime.startsWith('audio')?'audio':'video');media.muted=true;media.src=url;
          const result=await new Promise<boolean>(resolve=>{const timer=setTimeout(()=>resolve(media.currentTime>0),3000);media.onloadeddata=()=>void media.play().catch(()=>{});media.ontimeupdate=()=>{if(media.currentTime>0){clearTimeout(timer);resolve(true);}};media.onerror=()=>{clearTimeout(timer);resolve(false);};});media.pause();media.removeAttribute('src');URL.revokeObjectURL(url);return result;
        },{base64:sample.base64,mime:sample.mime});
        add({id:'playback-sample',product,state:playable?'PASS':'BLOCKED',severity:'P1',owner:'codex',module:'delivery',detail:playable?'Browser decoded/played the bounded sample':'Sample insufficient to establish playback; full file not downloaded automatically'});
        add({id:'full-file-integrity',product,state:'BLOCKED',severity:'P1',owner:'codex',module:'delivery',detail:'Full decode and content/lip-sync quality require isolated acceptance; periodic sample does not certify them'});
      }catch{add({id:'existing-asset',product,state:'BLOCKED',severity:'P1',owner:'codex',module:'delivery',detail:'Existing asset unavailable or not authorized for bounded read; no generation/retry'});}
    }
    for(const id of ['registration-confirmation','checkout-test','subscription-mutation','job-recovery','logout-action'])add({id,product:id==='checkout-test'||id==='subscription-mutation'?'commercial':'account-nav',state:'BLOCKED',severity:'P1',owner:'codex',module:'isolated-fixture',detail:'Mutating flow restricted to isolated environment; periodic production run does not execute it'});
    const finalBuild=await getJSON('/api/build-info');
    const stable=sha!==null&&finalBuild.status===200&&finalBuild.data?.sha===sha;
    add({id:'deployment-sha-stability',product:'account-nav',state:stable?'PASS':'BLOCKED',severity:'P1',owner:'codex',module:'deployment',detail:stable?'Application SHA stable before and after the traversal':'Unknown or changing deployment; no defect can be revalidated from mixed builds'});
    if(!stable)sha=null;
    add({id:'read-only-boundary',product:'account-nav',state:'PASS',severity:'P0',owner:'codex',module:'safety',detail:`Default-deny request guard active; ${blockedRequests} requests blocked; zero generation/checkout dispatches`});
    // No screenshots, DOM dumps, emails, media URLs, financial values or cookies are emitted.
  }finally{await browser.close();}
  return finish();
}
