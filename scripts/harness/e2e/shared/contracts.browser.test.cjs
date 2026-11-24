/** Browser regression fixtures for the harness; NOT authenticated app or paid generation. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { dismissFirstVisitTour } = require('./onboarding.cjs');
async function pageFor(run) {
 const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
 try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.route('http://local.test/**', route => route.fulfill({ contentType:'text/html', body:'<html><body></body></html>' }));
  await page.goto('http://local.test/dashboard');
  await run(page);
 } finally { await browser.close(); }
}
const tour = (delay, broken = false) => `<button id="download">Descargar video</button><script>
 setTimeout(() => { const d=document.createElement('div');d.setAttribute('role','dialog');d.setAttribute('aria-labelledby','onboarding-title');d.style='position:fixed;inset:0';d.innerHTML='<h2 id="onboarding-title">Escribe tu idea</h2><button>Omitir</button>';document.body.append(d);d.querySelector('button').onclick=()=>{${broken ? '' : "localStorage.setItem('atomivid_onboarding_completed_v1','1');d.remove();"}}; }, ${delay});</script>`;
test('delayed hydration beyond the former 4s wait: tour is really dismissed before download', () => pageFor(async p => {
 await p.setContent(tour(4500));
 await dismissFirstVisitTour(p, { timeout: 8000 });
 assert.equal(await p.getByRole('dialog').count(),0);
 await p.getByRole('button',{name:'Descargar video'}).click();
 assert.equal(await p.evaluate(()=>localStorage.getItem('atomivid_onboarding_completed_v1')),'1');
}));
test('broken dismissal must fail, never become PASS', () => pageFor(async p => {
 await p.setContent(tour(0,true));
 await assert.rejects(dismissFirstVisitTour(p,{timeout:300}), /Timeout/);
}));
test('repeat visit with persisted completion does not wait for a nonexistent tour', () => pageFor(async p => {
 await p.evaluate(()=>localStorage.setItem('atomivid_onboarding_completed_v1','1'));
 await dismissFirstVisitTour(p,{timeout:500});
}));
test('visible-header contract supports both prior strip and current lg strip, without duplicate hidden links', () => pageFor(async p => {
 for (const css of ['sm:hidden','lg:hidden']) {
  await p.setContent(`<header><nav style="display:none"><a href="/dashboard/podcast">Podcast</a></nav><div class="${css}"><a href="/dashboard/podcast">Podcast</a></div></header>`);
  const link=p.locator('header a[href="/dashboard/podcast"]:visible');
  assert.equal(await link.count(),1);assert.equal(await link.innerText(),'Podcast');
 }
}));
test('wrong route or missing navigation remains a failure', () => pageFor(async p => {
 await p.setContent('<header><a href="/dashboard/audio-studio">Podcast</a></header>');
 assert.equal(await p.locator('header a[href="/dashboard/podcast"]:visible').count(),0);
}));
