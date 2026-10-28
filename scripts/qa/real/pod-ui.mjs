// USD 0: recorre el asistente del estudio en PRODUCCIÓN con la sesión del dueño, en escritorio y en móvil, SIN generar:
// anfitrión del catálogo con voz automática, vista previa de los tres estudios, estimación (gratis) con Recraft, y el
// indicador de progreso de «Tus episodios». Nunca pulsa «Generar episodio» ni «Generar conversación» (esa usa IA).
// Capturas a $EVID (cifrado). Hechos no sensibles por consola.
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

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
for (const [label, opts] of [["escritorio", { viewport: { width: 1366, height: 900 } }], ["movil", { ...devices["iPhone 13"] }]]) {
  const ctx = await browser.newContext({ ...opts, storageState: stateFor() });
  const p = await ctx.newPage();
  const shot = (n) => p.screenshot({ path: path.join(EVID, `${label}-${n}.png`), fullPage: true }).catch(() => {});
  const next = async () => { await p.getByRole("button", { name: "Siguiente", exact: true }).click(); await p.waitForTimeout(600); };
  const title = () => p.getByTestId("wizard-step-title").innerText();
  const noHScroll = async (n) => { const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]); ok(`${label}: sin desplazamiento horizontal (${n})`, sw <= iw + 1, `${sw}/${iw}`); };
  try {
    const resp = await p.goto(`${APP}/dashboard/podcast`);
    console.log(`OPEN ${label} ${JSON.stringify({ status: resp?.status() ?? null, path: new URL(p.url()).pathname, host: new URL(p.url()).hostname })}`);
    if (!ok(`${label}: la vista previa abre el estudio con la sesión del dueño`, new URL(p.url()).hostname === HOST && /\/dashboard\/podcast/.test(p.url()), p.url().slice(0, 80))) { await shot("acceso"); await ctx.close(); continue; }
    await p.evaluate(() => { try { for (const k of Object.keys(localStorage)) if (/podcast/i.test(k)) localStorage.removeItem(k); } catch {} });
    await p.reload();
    await p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor({ timeout: 60000 });
    await p.getByTestId("modalidad-dialogo").click(); await next();
    await p.getByLabel("Título del episodio").fill("Prueba de interfaz (no se genera)");
    await p.getByLabel("Tema", { exact: true }).fill("Los sumerios y las tablillas cuneiformes");
    await p.getByLabel("Guion").fill(SCRIPT);
    await next();
    ok(`${label}: paso Participantes`, /Participantes/.test(await title()), await title());
    const grpA = p.getByRole("radiogroup", { name: /Participante A/ }), grpB = p.getByRole("radiogroup", { name: /Participante B/ });
    ok(`${label}: catálogo con 3 anfitriones`, (await grpA.locator('[data-testid^="anfitrion-"]').count()) === 3);
    const photos = await grpA.locator("img").evaluateAll((els) => els.map((e) => e.complete && e.naturalWidth > 0));
    ok(`${label}: fotos de los anfitriones cargan`, photos.length === 3 && photos.every(Boolean), JSON.stringify(photos));
    ok(`${label}: muestras de voz`, (await grpA.locator("audio").count()) === 3);
    await grpA.getByTestId("anfitrion-valeria").getByRole("radio").click();
    await grpB.getByTestId("anfitrion-victor").getByRole("radio").click();
    await shot("1-anfitriones"); await noHScroll("anfitriones");
    await next();
    const voces = await p.locator('[data-testid^="voz-incluida-"]').allInnerTexts();
    ok(`${label}: voz cargada automáticamente (sin elegir)`, voces.length === 2 && /Callie/.test(voces[0]) && (await p.locator('select[aria-label^="Voz "]').count()) === 0, JSON.stringify(voces));
    await shot("2-voces");
    await next();
    ok(`${label}: avatares incluidos`, (await p.locator('[data-testid^="avatar-incluido-"]').count()) === 2);
    await next(); await next();
    ok(`${label}: paso Visuales`, /Visuales/.test(await title()), await title());
    const provs = await p.locator('[data-testid^="proveedor-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    ok(`${label}: Recraft es el proveedor y Pexels no aparece`, provs.includes("proveedor-recraft") && !provs.some((x) => /pexels/.test(x)), JSON.stringify(provs));
    for (const s of ["moderno", "calido", "minimalista"]) {
      await p.getByTestId(`estudio-${s}`).click(); await p.waitForTimeout(800);
      const imgs = await p.getByTestId(`studio-preview-${s}`).locator("img").evaluateAll((els) => els.map((e) => e.complete && e.naturalWidth > 0));
      ok(`${label}: vista previa ${s} (estudio + 2 personas + mesa)`, imgs.length >= 4 && imgs.every(Boolean), JSON.stringify(imgs));
      await p.getByTestId(`studio-preview-${s}`).screenshot({ path: path.join(EVID, `${label}-3-estudio-${s}.png`) }).catch(() => {});
    }
    await shot("3-visuales"); await noHScroll("visuales");
    await next();
    await p.getByRole("button", { name: "Calcular costo" }).click().catch(() => {});
    await p.getByTestId("costo-por-proveedor").waitFor({ timeout: 60000 }).catch(() => {});
    const est = await p.getByTestId("wizard-estimate").innerText().catch(() => "");
    ok(`${label}: la estimación incluye Recraft`, /recraft/i.test(est), est.replace(/\s+/g, " ").slice(0, 400));
    await shot("4-presupuesto"); await noHScroll("presupuesto");
    // Indicador de «Tus episodios» (episodios ya existentes: solo se mira).
    const prog = p.getByTestId("atom-progress");
    const n = await prog.count();
    const states = n ? await prog.evaluateAll((els) => els.map((e) => e.getAttribute("data-state"))) : [];
    console.log(`PROGRESS ${label} ${JSON.stringify({ n, states })}`);
    const list = p.getByTestId("studio-episodes");
    if (await list.count()) await list.screenshot({ path: path.join(EVID, `${label}-5-episodios.png`) }).catch(() => {});
    ok(`${label}: nunca «En cola» en episodios ya iniciados`, !(/En cola/.test(await list.innerText().catch(() => ""))));
  } catch (e) { ok(`${label}: recorrido sin errores`, false, String(e?.message ?? e).slice(0, 300)); await shot("error"); }
  await p.evaluate(() => { try { for (const k of Object.keys(localStorage)) if (/podcast/i.test(k)) localStorage.removeItem(k); } catch {} }).catch(() => {});
  await ctx.close();
}
await browser.close();
console.log(`RESULT pod-ui: ${fails} FAIL`);
process.exit(fails ? 1 : 0);
