// PRUEBA GRATUITA (b), autorizada por Hans el 2026-10-30: en PRODUCCIÓN, con la sesión del dueño y el asistente LIMPIO,
// «Generar episodio» envía de verdad la CREACIÓN (registro «draft», sin cargo) y se BLOQUEA en el navegador la
// AUTORIZACIÓN (la que despacha el worker y cobra): nunca sale. Se comprueba en Supabase que el registro existe como
// borrador sin autorización, sin reservas ni operaciones pagadas, y que ningún worker arrancó.
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
    await W().getByTestId("modalidad-dialogo").click(); await next();
    await W().getByLabel("Título del episodio").fill("Prueba gratuita de creación (borrador, no se genera)");
    await W().getByLabel("Tema", { exact: true }).fill("Los sumerios y las tablillas cuneiformes");
    await W().getByLabel("Guion").fill(SCRIPT);
    await next();
    ok(`${label}: paso Participantes`, /Participantes/.test(await title()), await title());
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
    await next();
    const voces = await W().locator('[data-testid^="voz-incluida-"]').allInnerTexts();
    ok(`${label}: voz cargada automáticamente (sin elegir)`, voces.length === 2 && /Callie/.test(voces[0]) && (await W().locator('select[aria-label^="Voz "]').count()) === 0, JSON.stringify(voces));
    await shot("2-voces");
    await next();
    ok(`${label}: avatares incluidos`, (await W().locator('[data-testid^="avatar-incluido-"]').count()) === 2);
    await next(); await next();
    ok(`${label}: paso Visuales`, /Visuales/.test(await title()), await title());
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
      ok(`${label}: con Recraft no listo el asistente no avanza y lo explica`, /Visuales/.test(await title()) && /No disponible/.test(al), al.slice(0, 200));
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
    ok(`${label}: estimación cargada en Presupuesto`, /ElevenLabs/.test(est), est.slice(0, 200));
    await next(); // Vista previa
    console.log(`STEP ${label} ${await title()}`);
    await shot("5-vista"); await next(); // Generación
    console.log(`STEP ${label} ${await title()}`);
    await shot("6-generacion-antes");
    const blockedTxt = await W().getByTestId("generacion-bloqueada").innerText().catch(() => null);
    console.log(`MODE_BLOCKED ${label} ${JSON.stringify(blockedTxt)}`);
    const gen = W().getByRole("button", { name: "Generar episodio" });
    const genCount = await gen.count();
    const disabledBefore = genCount ? await gen.isDisabled() : null;
    console.log(`GEN_BUTTON ${label} ${JSON.stringify({ count: genCount, disabledBefore, text: (await W().getByTestId("wizard-step-title").innerText().catch(() => "")) })}`);
    ok(`${label}: el paso Generación muestra «Generar episodio»`, genCount === 1, blockedTxt ?? "");
    if (genCount === 1) {
      const box = W().getByLabel("Autorizo el cargo");
      await box.check();
      const disabledAfter = await gen.isDisabled();
      console.log(`GEN_BUTTON_AFTER_CHECK ${label} ${JSON.stringify({ disabledAfter })}`);
      ok(`${label}: con la casilla marcada el botón se habilita`, !disabledAfter);
      // Solo la CREACIÓN llega al servidor; cualquier otro POST (autorización = despacho y cargo) se aborta en el navegador.
      const sent = []; let created = null;
      await p.route("**/api/podcast/**", async (route) => {
        const req = route.request(); const url = new URL(req.url()).pathname; const body = req.postData() ?? "";
        if (req.method() === "GET") return route.continue();
        const isCreate = url === "/api/podcast/v3" && /"action":"create"/.test(body);
        const isEstimate = url === "/api/podcast/v3" && /"action":"estimate"/.test(body);
        sent.push({ url, kind: isCreate ? "create" : isEstimate ? "estimate" : /"confirm":true/.test(body) ? "authorize(bloqueada)" : "otro(bloqueado)" });
        if (isCreate) { const r = await route.fetch(); const t = await r.text(); created = { status: r.status(), id: /"id":"([0-9a-f-]{36})"/.exec(t)?.[1] ?? null, error: /"error":"([^"]+)"/.exec(t)?.[1] ?? null }; return route.fulfill({ response: r, body: t }); }
        if (isEstimate) return route.continue();
        return route.abort("failed");
      });
      if (!disabledAfter && label === "escritorio") {
        await gen.scrollIntoViewIfNeeded(); await gen.click(); await p.waitForTimeout(6000);
        const alertTxt = await W().getByRole("alert").innerText().catch(() => "");
        console.log(`CREATE ${label} ${JSON.stringify({ sent, created, alert: alertTxt.slice(0, 160) })}`);
        await shot("7-tras-crear");
        ok(`${label}: la plataforma CREA el registro en producción (respuesta 200 con id)`, created?.status === 200 && !!created.id, JSON.stringify(created));
        ok(`${label}: la autorización (despacho y cargo) NO salió del navegador`, sent.filter((x) => x.kind.startsWith("authorize")).length === 1 && !sent.some((x) => x.kind === "otro(bloqueado)"), JSON.stringify(sent));
        if (created?.id) {
          const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/podcast_studio_episodes?select=id,status,authorized_at,authorized_usd,run_started_at,estimated_usd,title,created_at&id=eq.${created.id}`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } });
          const row = (await r.json())[0];
          console.log(`DB_ROW ${JSON.stringify({ ...row, id: String(row?.id).slice(0, 8) })}`);
          ok("Supabase: el registro existe como borrador, sin autorización ni arranque", row?.status === "draft" && row.authorized_at === null && row.run_started_at === null, JSON.stringify(row));
          const ops = await fetch(`${process.env.SUPABASE_URL}/rest/v1/podcast_studio_operations?select=key&episode_id=eq.${created.id}`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }).then((x) => x.json());
          ok("Supabase: cero operaciones del estudio para el borrador (nada reservado ni cobrado)", Array.isArray(ops) && ops.length === 0, JSON.stringify(ops).slice(0, 120));
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
  const same = (k) => AFTER[k] === BEFORE[k];
  ok("solo +1 episodio (el borrador); sin autorizaciones, reservas, operaciones pagadas ni snapshots nuevos", AFTER.studioEpisodes === BEFORE.studioEpisodes + 1 && ["studioAuthorized", "studioOps", "recraftPaidOps", "recraftSnapshots", "podcastEpisodes"].every(same), JSON.stringify({ BEFORE, AFTER }));
}
console.log(`RESULT pod-crear: ${fails} FAIL`);
process.exit(fails ? 1 : 0);
