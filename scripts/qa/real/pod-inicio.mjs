// USD 0, SIN ESCRITURAS: diagnóstico de «pulsé Generar y no pasó nada» en PRODUCCIÓN con la sesión del dueño. Recorre el
// asistente como pod-ui hasta «Generación», pulsa «Generar episodio» con las peticiones POST a la API del podcast
// INTERCEPTADAS (nunca llegan al servidor: no se crea ni se autoriza nada) y mide lo que ve el usuario. Después pide al
// servidor la estimación gratuita con el mismo episodio para saber si lo rechazaría y por qué. Conteos antes/después.
import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "playwright";

// Producción (tras la fusión de #244, autorizada por el dueño el 2026-10-28). POD_UI_URL permite apuntar a otra URL;
// la sesión del dueño se copia a ese dominio. Solo lectura: nunca se genera nada.
const APP = process.env.POD_UI_URL || "https://atomivid.vercel.app", EVID = process.env.EVID;
const HOST = new URL(APP).hostname;
const stateFor = () => { const st = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); st.cookies = (st.cookies ?? []).map((c) => ({ ...c, domain: HOST })); st.origins = []; return st; };
fs.mkdirSync(EVID, { recursive: true });
let fails = 0;
const ok = (name, cond, info = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${info ? ` — ${info}` : ""}`); if (!cond) fails++; return cond; };
const SCRIPT = [
  "Valeria Montclair: Bienvenidos. Hoy hablamos de los sumerios y de las tablillas cuneiformes que nos dejaron.",
  "Víctor Albarrán: Gracias, Valeria. Son de los textos escritos más antiguos que conocemos, de hace más de cinco mil años.",
  "Valeria Montclair: ¿Y qué cuentan exactamente esas tablillas?",
  "Víctor Albarrán: Hay cuentas de cebada, contratos, leyes y también relatos como la epopeya de Gilgamesh.",
  "Valeria Montclair: Entonces no todo es mitología.",
  "Víctor Albarrán: Exacto. La mayoría son registros cotidianos; los mitos son una parte pequeña y muy interesante.",
].join("\n");

// POD_UI_UNTIL=visuales: smoke sin estimar (se detiene en «Visuales»). Conteos de SOLO LECTURA antes/después para probar
// que el recorrido no crea episodios, autorizaciones, reservas ni gasto.
const UNTIL = "";
const count = async (table, filter = "") => {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?select=*${filter}`, { method: "HEAD", headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: "count=exact" } });
  return Number((r.headers.get("content-range") ?? "").split("/")[1] ?? NaN);
};
const ledger = async () => {
  const own = `&user_id=eq.${process.env.OWNER_ID}`;
  return { studioEpisodes: await count("podcast_studio_episodes", own), studioAuthorized: await count("podcast_studio_episodes", `${own}&authorized_at=not.is.null`),
    studioOps: await count("podcast_studio_operations"), recraftPaidOps: await count("pi_paid_operations", "&provider=eq.recraft"), recraftSnapshots: await count("pi_capacity_snapshots", "&provider=eq.recraft"),
    podcastEpisodes: await count("podcast_episodes", own) };
};
const BEFORE = await ledger();
if (BEFORE) console.log(`LEDGER_BEFORE ${JSON.stringify(BEFORE)}`);
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
for (const [label, opts] of [["escritorio", { viewport: { width: 1366, height: 900 } }], ["movil", { ...devices["iPhone 13"] }]]) {
  const ctx = await browser.newContext({ ...opts, storageState: stateFor() });
  // Como el E2E de CI: el recorrido de bienvenida ya visto (una sesión nueva del navegador lo mostraría encima del asistente).
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage();
  const shot = (n) => p.screenshot({ path: path.join(EVID, `${label}-${n}.png`), fullPage: true }).catch(() => {});
  const W = () => p.getByTestId("podcast-wizard");
  const next = async () => { await W().getByRole("button", { name: "Siguiente", exact: true }).click(); await p.waitForTimeout(600); };
  const title = () => W().getByTestId("wizard-step-title").innerText();
  const noHScroll = async (n) => { const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]); ok(`${label}: sin desplazamiento horizontal (${n})`, sw <= iw + 1, `${sw}/${iw}`); };
  try {
    const resp = await p.goto(`${APP}/dashboard/podcast`);
    console.log(`OPEN ${label} ${JSON.stringify({ status: resp?.status() ?? null, path: new URL(p.url()).pathname, host: new URL(p.url()).hostname })}`);
    if (!ok(`${label}: la vista previa abre el estudio con la sesión del dueño`, new URL(p.url()).hostname === HOST && /\/dashboard\/podcast/.test(p.url()), p.url().slice(0, 80))) { await shot("acceso"); await ctx.close(); continue; }
    await p.evaluate(() => { try { for (const k of Object.keys(localStorage)) if (/podcast/i.test(k)) localStorage.removeItem(k); } catch {} });
    await p.reload();
    await p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor({ timeout: 60000 });
    // Premium 4.0 (PR #252): 4 pantallas — Participantes (tipo, anfitriones, voces, avatares) → Contenido → Estilo → Producir.
    ok(`${label}: paso 1 de 4 Participantes`, /Paso 1 de 4: Participantes/.test(await title()), await title());
    await W().getByTestId("modalidad-dialogo").click();
    const grpA = W().getByRole("radiogroup", { name: /Participante A/ }), grpB = W().getByRole("radiogroup", { name: /Participante B/ });
    ok(`${label}: catálogo con 3 anfitriones`, (await grpA.locator('[data-testid^="anfitrion-"]').count()) === 3);
    // Espera real a que terminen de cargar (hasta 30 s) y mide tiempo y peso de cada foto (Resource Timing).
    await grpA.locator("img").evaluateAll((els) => Promise.all(els.map((e) => e.complete ? 0 : new Promise((r) => { e.onload = e.onerror = r; setTimeout(r, 30000); }))));
    const photos = await grpA.locator("img").evaluateAll((els) => els.map((e) => ({ ok: e.complete && e.naturalWidth > 0, w: e.naturalWidth,
      ms: Math.round(performance.getEntriesByName(e.currentSrc)[0]?.duration ?? -1), kb: Math.round((performance.getEntriesByName(e.currentSrc)[0]?.transferSize ?? 0) / 1024) })));
    console.log(`PHOTOS ${label} ${JSON.stringify(photos)}`);
    ok(`${label}: fotos de los anfitriones cargan`, photos.length === 3 && photos.every((x) => x.ok), JSON.stringify(photos));
    ok(`${label}: muestras de voz`, (await grpA.locator("audio").count()) === 3);
    await grpA.getByTestId("anfitrion-valeria").getByRole("radio").click();
    await grpB.getByTestId("anfitrion-victor").getByRole("radio").click();
    await shot("1-anfitriones"); await noHScroll("anfitriones");
    const voces = await W().locator('[data-testid^="voz-incluida-"]').allInnerTexts();
    ok(`${label}: voz cargada automáticamente (sin elegir)`, voces.length === 2 && /Callie/.test(voces[0]) && (await W().locator('select[aria-label^="Voz "]').count()) === 0, JSON.stringify(voces));
    ok(`${label}: avatares incluidos`, (await W().locator('[data-testid^="avatar-incluido-"]').count()) === 2);
    await shot("2-voces"); await next();
    ok(`${label}: paso 2 de 4 Contenido`, /Paso 2 de 4: Contenido/.test(await title()), await title());
    await W().getByLabel("Título del episodio").fill("Prueba de interfaz (no se genera)");
    await W().getByLabel("Tema", { exact: true }).fill("Los sumerios y las tablillas cuneiformes");
    await W().getByLabel("Guion").fill(SCRIPT);
    await next();
    ok(`${label}: paso 3 de 4 Estilo`, /Paso 3 de 4: Estilo/.test(await title()), await title());
    const provs = await W().locator('[data-testid^="proveedor-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    ok(`${label}: Recraft es el proveedor y Pexels no aparece`, provs.includes("proveedor-recraft") && !provs.some((x) => /pexels/.test(x)), JSON.stringify(provs));
    for (const s of ["moderno", "calido", "minimalista"]) {
      await W().getByTestId(`estudio-${s}`).click(); await p.waitForTimeout(800);
      const pv = W().getByTestId(`studio-preview-${s}`).last().locator("img");
      await pv.evaluateAll((els) => Promise.all(els.map((e) => e.complete ? 0 : new Promise((r) => { e.onload = e.onerror = r; setTimeout(r, 30000); }))));
      const imgs = await pv.evaluateAll((els) => els.map((e) => e.complete && e.naturalWidth > 0));
      ok(`${label}: vista previa ${s} (estudio + 2 personas + mesa)`, imgs.length >= 4 && imgs.every(Boolean), JSON.stringify(imgs));
      await W().getByTestId(`studio-preview-${s}`).last().screenshot({ path: path.join(EVID, `${label}-3-estudio-${s}.png`) }).catch(() => {});
    }
    await shot("3-visuales"); await noHScroll("visuales");
    // Estado REAL de Recraft (política y saldo): si hoy no puede producir, el motivo se ve y el asistente no avanza con él;
    // entonces se sigue con «Solo estudio y anfitriones». Si está listo, la estimación lo incluye.
    const rc = (await W().getByTestId("proveedor-recraft").innerText()).replace(/\s+/g, " ");
    const recraftBlocked = /No disponible/.test(rc);
    console.log(`RECRAFT ${label} ${JSON.stringify({ blocked: recraftBlocked, text: rc.slice(0, 240) })}`);
    if (UNTIL) ok(`${label}: Recraft aparece NO disponible antes de autorizar`, recraftBlocked, rc.slice(0, 240));
    if (recraftBlocked) {
      ok(`${label}: Recraft no listo muestra el motivo y que no se cobra`, /No se cobra nada/.test(rc), rc.slice(0, 240));
      await W().getByRole("button", { name: "Siguiente", exact: true }).click(); await p.waitForTimeout(600);
      const al = await W().getByRole("alert").innerText().catch(() => "");
      ok(`${label}: con Recraft no listo el asistente no avanza y lo explica`, /Estilo/.test(await title()) && /No disponible/.test(al), al.slice(0, 200));
      const solo = W().getByLabel("Solo estudio y anfitriones (sin imágenes)");
      await solo.check();
      ok(`${label}: «Solo estudio y anfitriones» sigue seleccionable`, await solo.isEnabled() && await solo.isChecked() && !/No disponible/.test(await W().getByTestId("proveedor-solo_set").innerText()));
      await shot("3b-solo-estudio");
    }
    if (UNTIL === "visuales") throw Object.assign(new Error("STOP"), { stop: true });
    await next();
    await W().getByRole("button", { name: "Calcular costo" }).click().catch(() => {});
    await W().getByTestId("costo-por-proveedor").waitFor({ timeout: 60000 }).catch(() => {});
    const est = (await W().getByTestId("wizard-estimate").innerText().catch(() => "")).replace(/\s+/g, " ");
    console.log(`ESTIMATE ${label} ${est.slice(0, 500)}`);
    ok(`${label}: estimación cargada en Producir`, /ElevenLabs/.test(est), est.slice(0, 200));
    console.log(`STEP ${label} ${await title()}`);
    await shot("5-vista");
    await shot("6-generacion-antes");
    const blockedTxt = await W().getByTestId("generacion-bloqueada").innerText().catch(() => null);
    console.log(`MODE_BLOCKED ${label} ${JSON.stringify(blockedTxt)}`);
    const gen = W().getByRole("button", { name: "Generar episodio" });
    const genCount = await gen.count();
    const disabledBefore = genCount ? await gen.isDisabled() : null;
    console.log(`GEN_BUTTON ${label} ${JSON.stringify({ count: genCount, disabledBefore, text: (await W().getByTestId("wizard-step-title").innerText().catch(() => "")) })}`);
    ok(`${label}: Producir muestra «Generar episodio» (deshabilitado sin autorización, con su motivo)`, genCount === 1 && disabledBefore === true && /autoriz/i.test(await W().getByTestId("motivo-generar").innerText().catch(() => "")), blockedTxt ?? "");
    if (genCount === 1) {
      const box = W().getByLabel("Autorizo el cargo");
      await box.check();
      const disabledAfter = await gen.isDisabled();
      console.log(`GEN_BUTTON_AFTER_CHECK ${label} ${JSON.stringify({ disabledAfter })}`);
      ok(`${label}: con la casilla marcada el botón se habilita`, !disabledAfter);
      // Intercepción: ningún POST a la API del podcast sale del navegador; se guarda lo que se habría enviado.
      const sent = [];
      await p.route("**/api/podcast/**", async (route) => {
        const req = route.request();
        if (req.method() !== "GET") { sent.push({ url: new URL(req.url()).pathname, body: req.postData() }); return route.abort("failed"); }
        return route.continue();
      });
      if (!disabledAfter) {
        await gen.scrollIntoViewIfNeeded(); await gen.click(); await p.waitForTimeout(3000);
        const alert = W().getByRole("alert");
        const alertTxt = await alert.innerText().catch(() => "");
        const vis = await alert.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, inView: r.top >= 0 && r.bottom <= window.innerHeight }; }).catch(() => null);
        const btn = await gen.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; }).catch(() => null);
        console.log(`AFTER_CLICK ${label} ${JSON.stringify({ requests: sent.map((s) => s.url), alert: alertTxt.slice(0, 200), alertBox: vis, buttonBox: btn, progress: await W().getByTestId("wizard-progress").count() })}`);
        await shot("7-generacion-despues");
        ok(`${label}: al fallar el inicio, el mensaje queda a la vista junto al botón`, !!alertTxt && !!vis?.inView, JSON.stringify({ alertTxt: alertTxt.slice(0, 120), vis, btn }));
        // ¿Lo aceptaría el servidor? La estimación (gratis, sin escritura) aplica las mismas validaciones que «create».
        const createBody = sent.find((s) => s.url === "/api/podcast/v3")?.body;
        await p.unroute("**/api/podcast/**"); // la estimación es de solo lectura; sin esto se interceptaría también
        if (createBody) {
          const spec = JSON.parse(createBody).spec;
          const r = await p.evaluate(async (sp) => { const res = await fetch("/api/podcast/v3", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "estimate", spec: sp }) }); return { status: res.status, body: (await res.text()).slice(0, 300) }; }, spec).catch((e) => ({ status: -1, body: String(e) }));
          console.log(`SERVER_ESTIMATE ${label} ${JSON.stringify({ status: r.status, total: /"totalUsd":([0-9.]+)/.exec(r.body)?.[1] ?? null, error: /"error":"([^"]+)"/.exec(r.body)?.[1] ?? null, budget: spec?.budget_usd, provider: spec?.visual?.provider })}`);
        }
      }
      await p.unroute("**/api/podcast/**").catch(() => {});
    }
  } catch (e) { if (!e?.stop) { ok(`${label}: recorrido sin errores`, false, String(e?.message ?? e).slice(0, 300)); await shot("error"); } }
  await p.evaluate(() => { try { for (const k of Object.keys(localStorage)) if (/podcast/i.test(k)) localStorage.removeItem(k); } catch {} }).catch(() => {});
  await ctx.close();
}
await browser.close();
if (BEFORE) {
  const AFTER = await ledger();
  console.log(`LEDGER_AFTER ${JSON.stringify(AFTER)}`);
  ok("sin cambios: episodios, autorizaciones, reservas del estudio, operaciones pagadas ni snapshots", JSON.stringify(AFTER) === JSON.stringify(BEFORE) && Object.values(BEFORE).every(Number.isFinite), JSON.stringify({ BEFORE, AFTER }));
}
console.log(`RESULT pod-inicio: ${fails} FAIL`);
process.exit(fails ? 1 : 0);
