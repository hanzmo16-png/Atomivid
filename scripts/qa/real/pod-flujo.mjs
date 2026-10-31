// USD 0, sin escrituras: reproduce en PRODUCCIÓN el recorrido que reportó Hans («escribí el tema, pulsé Siguiente, apareció
// una carga, no se creó el episodio y después no pude volver a entrar»), con la sesión del dueño, en móvil y escritorio.
// Nunca pulsa «Generar conversación» (IA de pago) ni «Generar episodio». Solo la estimación gratuita de «Producir».
// Registra por pantalla: tiempo, errores de consola/página, respuestas ≥ 400 y peticiones lentas; y prueba volver a entrar
// (navegación desde el panel, recarga y URL directa) con el borrador guardado en cada pantalla. Conteos de solo lectura
// antes/después prueban que no se crea nada. Capturas cifradas en $EVID.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const APP = "https://atomivid.vercel.app", HOST = new URL(APP).hostname, EVID = process.env.EVID;
fs.mkdirSync(EVID, { recursive: true });
let fails = 0;
const ok = (name, cond, info = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${info !== "" ? ` — ${typeof info === "string" ? info : JSON.stringify(info)}` : ""}`); if (!cond) fails++; return cond; };
const count = async (table, filter = "") => {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?select=id${filter}`, { method: "HEAD", headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: "count=exact" } });
  return Number((r.headers.get("content-range") ?? "").split("/")[1] ?? NaN);
};
const ledger = async () => ({ studio: await count("podcast_studio_episodes"), ops: await count("podcast_studio_operations"), classic: await count("podcast_episodes") });
const BEFORE = await ledger();
console.log(`LEDGER_BEFORE ${JSON.stringify(BEFORE)}`);

const SCRIPT = [
  "Valeria Montclair: Bienvenidos. Hoy hablamos de los sumerios y de la escritura más antigua que conocemos.",
  "Víctor Albarrán: Gracias, Valeria. Hace más de cinco mil años marcaban tablillas de arcilla con un punzón.",
  "Valeria Montclair: ¿Y qué escribían en esas tablillas?",
  "Víctor Albarrán: Casi todo eran cuentas: cebada, ovejas, salarios y contratos.",
].join("\n");
const st = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); st.cookies = (st.cookies ?? []).map((c) => ({ ...c, domain: HOST })); st.origins = [];
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
const VIEWS = [["movil", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true }], ["escritorio", { viewport: { width: 1440, height: 900 } }]];
for (const [label, opts] of VIEWS) {
  const ctx = await browser.newContext({ ...opts, storageState: st, locale: "es-MX" });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(45000);
  const events = [];
  const started = new Map();
  p.on("console", (m) => { if (m.type() === "error") events.push({ k: "console", t: m.text().slice(0, 300) }); });
  p.on("pageerror", (e) => events.push({ k: "pageerror", t: String(e?.message ?? e).slice(0, 300) }));
  p.on("request", (r) => started.set(r, Date.now()));
  p.on("requestfailed", (r) => { const u = new URL(r.url()); if (u.hostname === HOST) events.push({ k: "failed", t: `${r.method()} ${u.pathname} ${r.failure()?.errorText ?? ""}` }); });
  p.on("response", (r) => { const u = new URL(r.url()); if (u.hostname !== HOST) return; const ms = Date.now() - (started.get(r.request()) ?? Date.now());
    if (r.status() >= 400 || ms > 8000) events.push({ k: r.status() >= 400 ? "http" : "slow", t: `${r.request().method()} ${u.pathname}${u.search.startsWith("?_rsc") ? "?_rsc" : ""} ${r.status()} ${ms}ms` }); });
  const flush = (tag) => { console.log(`EVENTS ${label} ${tag} ${JSON.stringify(events.splice(0))}`); };
  const shot = (n) => p.screenshot({ path: path.join(EVID, `${label}-${n}.png`), fullPage: true }).catch(() => {});
  const W = () => p.getByTestId("podcast-wizard");
  const state = async () => p.evaluate(() => {
    const w = document.querySelector('[data-testid="podcast-wizard"]');
    return { url: location.pathname, wizard: !!w, hydrated: w?.getAttribute("data-hydrated") ?? null, busy: !!document.querySelector('[aria-busy="true"]'),
      title: document.querySelector('[data-testid="wizard-step-title"]')?.textContent ?? null, alert: [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent?.slice(0, 200)),
      appError: /Application error|Algo salió mal|client-side exception/i.test(document.body.innerText), h1: document.querySelector("h1")?.textContent ?? null };
  });
  const open = async (how, fn) => {
    const t0 = Date.now(); let err = null;
    try { await fn(); await p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor({ timeout: 45000 }); } catch (e) { err = String(e.message).split("\n")[0].slice(0, 160); }
    const s = await state().catch(() => null);
    ok(`${label}: volver a entrar (${how}) abre el asistente`, !err && !!s?.wizard && !s?.appError, { ms: Date.now() - t0, err, s });
    flush(`entrar-${how}`);
    return s;
  };
  const next = async (tag) => {
    const t0 = Date.now();
    await W().getByRole("button", { name: "Siguiente", exact: true }).click();
    await p.waitForTimeout(1500);
    const s = await state();
    console.log(`STEP ${label} ${tag} ${JSON.stringify({ ms: Date.now() - t0, ...s })}`);
    flush(tag);
    return s;
  };
  try {
    await open("primera", () => p.goto(`${APP}/dashboard/podcast`));
    await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (/podcast/i.test(k)) localStorage.removeItem(k); });
    await open("recarga-limpia", () => p.reload());
    // 1 — Participantes
    await W().getByTestId("modalidad-dialogo").click();
    await W().getByRole("radiogroup", { name: /Participante A/ }).getByTestId("anfitrion-valeria").getByRole("radio").click();
    await W().getByRole("radiogroup", { name: /Participante B/ }).getByTestId("anfitrion-victor").getByRole("radio").click();
    await shot("1-participantes");
    let s = await next("participantes→contenido");
    ok(`${label}: pantalla Contenido`, /Contenido/.test(s.title ?? ""), s.title);
    // 2 — Contenido: como Hans, SOLO el tema y «Siguiente».
    await W().getByLabel("Título del episodio").fill("Prueba de flujo (no se genera)");
    await W().getByLabel("Tema").fill("Los sumerios y el origen de la escritura");
    s = await next("contenido-solo-tema");
    await shot("2-contenido-solo-tema");
    ok(`${label}: con solo el tema, «Siguiente» explica qué falta y no se queda cargando`, /Contenido/.test(s.title ?? "") && !s.busy && s.alert.join(" ").length > 0, s);
    // Volver a entrar con el borrador guardado en Contenido.
    await open("panel→podcast(contenido)", async () => { await p.goto(`${APP}/dashboard`); await p.getByRole("link", { name: /Podcast/ }).first().click(); });
    await open("url-directa(contenido)", () => p.goto(`${APP}/dashboard/podcast`));
    // Guion pegado → Estilo → Producir (estimación gratis).
    await W().getByLabel("Guion").fill(SCRIPT);
    s = await next("contenido→estilo");
    ok(`${label}: pantalla Estilo`, /Estilo/.test(s.title ?? ""), s.title);
    await W().getByLabel("Solo estudio y anfitriones (sin imágenes)").check();
    await shot("3-estilo");
    await open("recarga(estilo)", () => p.reload());
    s = await next("estilo→producir");
    await W().getByTestId("wizard-estimate").locator("table").waitFor({ timeout: 60000 }).catch(() => {});
    s = await state(); flush("producir");
    await shot("4-producir");
    ok(`${label}: pantalla Producir con estimación`, /Producir/.test(s.title ?? "") && (await W().getByTestId("wizard-estimate").locator("table").count()) > 0, s);
    await open("recarga(producir)", () => p.reload());
    await open("panel→podcast(producir)", async () => { await p.goto(`${APP}/dashboard`); await p.getByRole("link", { name: /Podcast/ }).first().click(); });
    await shot("5-reentrada");
  } catch (e) {
    ok(`${label}: recorrido sin excepción`, false, String(e.message).split("\n")[0].slice(0, 200));
    console.log(`STATE ${label} ${JSON.stringify(await state().catch(() => null))}`); flush("excepcion"); await shot("excepcion");
  }
  await ctx.close();
}
await browser.close();
const AFTER = await ledger();
console.log(`LEDGER_AFTER ${JSON.stringify(AFTER)}`);
ok("sin escrituras: episodios, operaciones y clásicos sin cambios", JSON.stringify(BEFORE) === JSON.stringify(AFTER), { BEFORE, AFTER });
console.log(`RESULT pod-flujo: ${fails ? `FALLA (${fails})` : "OK"}`);
process.exit(fails ? 1 : 0);
