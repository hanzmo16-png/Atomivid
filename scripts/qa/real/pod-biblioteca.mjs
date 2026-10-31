// USD 0, SOLO LECTURA: biblioteca de Podcast (PR #254) en la VISTA PREVIA del PR con la sesión de la cuenta dueña (pasa el
// gate canAccessLongFormBeta; no se relaja ningún control). Acceso a la vista previa protegida con el bypass de Vercel para
// automatización (autorizado por Hans el 2026-10-31; el secreto nunca se registra ni se envía a terceros).
// Samsung 390×844 y escritorio 1440×900:
//  - /dashboard/podcast carga (200, h1 «Podcast») y el menú ofrece «Podcast»;
//  - «Mis episodios» y «Archivados» muestran EXACTAMENTE el orden que calcula library.ts del PR sobre los mismos datos;
//  - todo lo que se ve es del dueño; sin archived_at hay aviso y ningún botón; con archived_at hay botones y no se pulsan;
//  - sin desbordamiento horizontal; la página no envía escrituras; el número de filas no cambia.
// Registro sin títulos ni ids: solo conteos y PASS/FAIL. Capturas cifradas a $EVID.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const APP = process.env.POD_UI_URL, BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "", EVID = process.env.EVID, OWNER = process.env.OWNER_ID;
// Producción (sesión del dueño, sin bypass) o una vista previa del PR (requiere el bypass de Vercel para automatización).
const PRODUCTION = APP === "https://atomivid.vercel.app";
if (!APP || !(PRODUCTION || /^https:\/\/atomivid-[a-z0-9-]+-atomivid\.vercel\.app$/.test(APP))) { console.log("FAIL pod-biblioteca: URL no permitida"); process.exit(1); }
if (!PRODUCTION && !BYPASS) { console.log("FAIL pod-biblioteca: falta el secreto de bypass de Vercel (solo vistas previas)"); process.exit(1); }
const { libraryView } = await import(process.env.LIBRARY_TS);
const HOST = new URL(APP).hostname;
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
fs.mkdirSync(EVID, { recursive: true });
let fails = 0, passes = 0;
const ok = (name, cond, detail) => { cond ? passes++ : fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || detail === undefined ? "" : "  " + JSON.stringify(detail).slice(0, 300)}`); };

const read = async (table, cols) => {
  const q = (c) => db.from(table).select(c).eq("user_id", OWNER).order("updated_at", { ascending: false }).limit(100);
  let r = await q(`${cols},archived_at`); const column = !r.error;
  if (!column) r = await q(cols);
  if (r.error) throw new Error(`lectura ${table}`);
  return { rows: r.data, column };
};
const counts = async () => {
  const n = async (t) => (await db.from(t).select("id", { count: "exact", head: true })).count ?? -1;
  return { studio: await n("podcast_studio_episodes"), v2: await n("podcast_episodes") };
};
const before = await counts();
const st = await read("podcast_studio_episodes", "id,title,status,created_at,updated_at");
const v2 = await read("podcast_episodes", "id,title,status,video_status,created_at,updated_at");
const column = st.column && v2.column;
const all = [...st.rows.map((r) => ({ ...r, kind: "studio" })), ...v2.rows.map((r) => ({ ...r, kind: "v2" }))];
const tid = (e) => (e.kind === "studio" ? `studio-episode-${e.id}` : `episodio-v2-${e.id}`);
const expected = { principal: libraryView(all, "principal").map(tid), archivados: libraryView(all, "archivados").map(tid) };
const ownerIds = new Set(all.map(tid));
console.log(`DATOS estudio=${st.rows.length} clasico=${v2.rows.length} principal=${expected.principal.length} archivados=${expected.archivados.length} columna_archived_at=${column}`);

const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
state.cookies = (state.cookies ?? []).map((c) => ({ ...c, domain: HOST })); state.origins = [];
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
const DEVICES = { "samsung-390": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true }, "escritorio-1440": { viewport: { width: 1440, height: 900 } } };
for (const [dev, opts] of Object.entries(DEVICES)) {
  const ctx = await browser.newContext({ ...opts, storageState: state, locale: "es-MX" });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(60000);
  // Cookie de acceso de Vercel, una sola vez y solo en el origen de la vista previa.
  if (!PRODUCTION) await p.goto(`${APP}/?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}&x-vercel-set-bypass-cookie=samesitenone`, { waitUntil: "domcontentloaded" });
  // Envíos no-GET: se registran método + host + ruta (sin consulta ni cuerpo) para distinguir escrituras de datos de
  // telemetría o renovación de sesión.
  // La telemetría de Sentry (ingest.*.sentry.io) no escribe datos de la app: se cuenta aparte.
  const writes = [], telemetry = []; p.on("request", (r) => { if (r.method() !== "GET" && !/_next|__nextjs/.test(r.url())) { const u = new URL(r.url()); (/\.ingest\.[a-z.]*sentry\.io$/.test(u.host) ? telemetry : writes).push(`${r.method()} ${u.host === HOST ? "app" : u.host.replace(/^[^.]+\.supabase\.co$/, "supabase")}${u.pathname}`); } });
  // Errores de JavaScript en la página (excepciones sin capturar y console.error): solo se cuentan y se muestra el inicio.
  const jsErrors = []; p.on("pageerror", (e) => jsErrors.push(`pageerror: ${String(e?.message ?? e).slice(0, 120)}`)); p.on("console", (m) => { if (m.type() === "error") jsErrors.push(`console: ${m.text().slice(0, 120)}`); });
  for (const view of ["principal", "archivados"]) {
    const r = await p.goto(`${APP}/dashboard/podcast${view === "archivados" ? "?vista=archivados" : ""}`);
    const status = r?.status() ?? null, loginRedirect = /\/login/.test(p.url());
    ok(`[${dev}] ${view}: /dashboard/podcast carga con la cuenta autorizada (HTTP ${status})`, status === 200 && !loginRedirect, { status, login: loginRedirect });
    if (status !== 200 || loginRedirect) continue;
    await p.getByTestId("biblioteca-vistas").waitFor();
    const seq = await p.locator('[data-testid="studio-episodes"] > li').evaluateAll((ls) => ls.map((l) => l.getAttribute("data-testid")));
    ok(`[${dev}] ${view}: el orden en pantalla es el de la biblioteca unificada (${seq.length} episodios)`, JSON.stringify(seq) === JSON.stringify(expected[view]), { en_pantalla: seq.length, esperado: expected[view].length, primera_diferencia: seq.findIndex((x, i) => x !== expected[view][i]) });
    ok(`[${dev}] ${view}: todo lo que se ve es del dueño`, seq.every((x) => ownerIds.has(x)));
    const blocked = await p.getByTestId("biblioteca-archivo-bloqueado").count();
    const buttons = await p.locator('[data-testid^="biblioteca-archivar-"],[data-testid^="biblioteca-restaurar-"]').count();
    if (!column) ok(`[${dev}] ${view}: sin archived_at hay aviso y ningún botón de archivar/restaurar`, blocked === 1 && buttons === 0, { blocked, buttons });
    else ok(`[${dev}] ${view}: con archived_at no hay aviso de bloqueo${view === "principal" ? " y se ofrece archivar (no se pulsa)" : ""}`, blocked === 0 && (view !== "principal" || expected.principal.length === 0 || buttons > 0), { blocked, buttons });
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(`[${dev}] ${view}: sin desbordamiento horizontal`, ov <= 1, `${ov}px`);
    if (view === "principal") {
      const nav = await p.locator("header a").evaluateAll((a) => a.map((x) => x.getAttribute("href")));
      ok(`[${dev}] el menú ofrece «Podcast» a la cuenta autorizada`, nav.includes("/dashboard/podcast"));
    }
    await p.screenshot({ path: path.join(EVID, `${dev}-${view}.png`), fullPage: true });
  }
  ok(`[${dev}] la biblioteca no envió escrituras a la app ni a la base (POST/PUT/PATCH/DELETE)`, writes.length === 0, writes.slice(0, 5));
  console.log(`INFO [${dev}] telemetría Sentry enviada: ${telemetry.length}`);
  ok(`[${dev}] sin errores de JavaScript en la página`, jsErrors.length === 0, jsErrors.slice(0, 5));
  await ctx.close();
}
await browser.close();
const after = await counts();
ok("el número de episodios no cambió (nada se borró)", JSON.stringify(before) === JSON.stringify(after), { before, after });
console.log(`RESULT pod-biblioteca: ${fails === 0 ? "OK" : "FALLA"} pass=${passes} fail=${fails}`);
process.exit(fails === 0 ? 0 : 1);
