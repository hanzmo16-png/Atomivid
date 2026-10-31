// USD 0, SOLO LECTURA: smoke posterior al despliegue de #258 / #259 en PRODUCCIÓN, con la sesión de la cuenta dueña
// (sin contraseña, session.mjs). No genera, no estima, no autoriza, no archiva: ningún proveedor ni cobro.
// Complementa pod-biblioteca.mjs (biblioteca: orden, archivados, dueño), que el mismo caso ejecuta antes.
// Samsung 390×844 y escritorio 1440×900:
//  - «Mis proyectos» (/dashboard) carga; con #258 desplegado, los guiones fallidos de más de 7 días están plegados en
//    «Guiones antiguos sin terminar» con el mismo número que la base y siguen dentro (no se borra nada);
//  - navegación: el menú ofrece «Podcast» y la página carga;
//  - con #259 desplegado: en el asistente (Conversación), los avatares guardados del dueño se ven junto al catálogo, con foto
//    por enlace FIRMADO de su propia carpeta (token=…), ninguno ajeno; un proveedor no disponible está deshabilitado y sin
//    marcar (el borrador se guarda solo en el navegador del smoke y se borra al final);
//  - reproducción y descarga de un episodio YA EXISTENTE del dueño (el «Listo» más reciente de la biblioteca): el reproductor
//    avanza, el enlace de descarga es firmado, de su carpeta, y responde con audio/video (solo se leen los primeros bytes);
//  - cero POST/PUT/PATCH/DELETE de la página, cero errores de JavaScript, sin desbordamiento, y la base no cambia.
// Registro sin títulos ni ids: conteos y PASS/FAIL. Capturas a $EVID (cifradas por el workflow).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const APP = "https://atomivid.vercel.app", HOST = new URL(APP).hostname, EVID = process.env.EVID, OWNER = process.env.OWNER_ID;
// Qué está desplegado: «base» (solo lo de hoy), «258» o «259» (acumulativo: 259 implica 258).
const LEVEL = process.env.SMOKE_LEVEL || "base";
if (!["base", "258", "259"].includes(LEVEL)) { console.log("FAIL smoke-lanzamiento: SMOKE_LEVEL no válido"); process.exit(1); }
const has258 = LEVEL !== "base", has259 = LEVEL === "259";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
fs.mkdirSync(EVID, { recursive: true });
let fails = 0, passes = 0;
const ok = (name, cond, detail) => { cond ? passes++ : fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || detail === undefined ? "" : "  " + JSON.stringify(detail).slice(0, 300)}`); };
const info = (m) => console.log(`INFO  ${m}`);

const counts = async () => {
  const n = async (t) => (await db.from(t).select("id", { count: "exact", head: true })).count ?? -1;
  return { studio: await n("podcast_studio_episodes"), v2: await n("podcast_episodes"), avatars: await n("avatars"), scriptJobs: await n("documentary_script_jobs"), requests: await n("video_requests") };
};
const before = await counts();

// Lo esperado, leído de la base con las mismas reglas que la página (solo lectura).
const cut = Date.now() - 7 * 86_400_000;
const jobs = (await db.from("documentary_script_jobs").select("id,status,created_at").eq("user_id", OWNER).neq("status", "completed").order("created_at", { ascending: false }).limit(30)).data ?? [];
const oldJobs = jobs.filter((j) => j.status === "failed" && Date.parse(j.created_at) < cut).length;
const avatars = (await db.from("avatars").select("id").eq("user_id", OWNER).eq("status", "ready").order("created_at", { ascending: false }).limit(20)).data ?? [];
const ownAvatarIds = new Set(avatars.map((a) => a.id));
const readyStudio = (await db.from("podcast_studio_episodes").select("id,status,archived_at,updated_at").eq("user_id", OWNER).eq("status", "ready").is("archived_at", null).order("updated_at", { ascending: false }).limit(1)).data ?? [];
info(`DATOS guiones_abiertos=${jobs.length} guiones_antiguos=${oldJobs} avatares_listos=${avatars.length} episodio_listo=${readyStudio.length ? "sí" : "no"} nivel=${LEVEL}`);

const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
state.cookies = (state.cookies ?? []).map((c) => ({ ...c, domain: HOST })); state.origins = [];
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
const DEVICES = { "samsung-390": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true }, "escritorio-1440": { viewport: { width: 1440, height: 900 } } };
const DRAFT = "atomivid.podcast.asistente.v2";
for (const [dev, opts] of Object.entries(DEVICES)) {
  const ctx = await browser.newContext({ ...opts, storageState: state, locale: "es-MX" });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(60000);
  // Envíos no-GET de la página (sin consulta ni cuerpo); la telemetría de Sentry se cuenta aparte.
  const writes = [], telemetry = []; p.on("request", (r) => { if (r.method() !== "GET" && !/_next|__nextjs/.test(r.url())) { const u = new URL(r.url()); (/\.ingest\.[a-z.]*sentry\.io$/.test(u.host) ? telemetry : writes).push(`${r.method()} ${u.host === HOST ? u.pathname : u.host}`); } });
  const jsErrors = []; p.on("pageerror", (e) => jsErrors.push(`pageerror: ${String(e?.message ?? e).slice(0, 120)}`)); p.on("console", (m) => { if (m.type() === "error") jsErrors.push(`console: ${m.text().slice(0, 120)}`); });
  const wide = async (n) => { const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); ok(`[${dev}] ${n}: sin desbordamiento horizontal`, o <= 1, `${o}px`); };

  // 1) «Mis proyectos» (#258).
  let r = await p.goto(`${APP}/dashboard`);
  ok(`[${dev}] «Mis proyectos» carga con la cuenta dueña (HTTP ${r?.status()})`, r?.status() === 200 && !/\/login/.test(p.url()));
  const folded = p.getByTestId("guiones-antiguos");
  if (has258) {
    if (oldJobs > 0) {
      const sum = (await folded.locator("summary").textContent().catch(() => "")) ?? "";
      ok(`[${dev}] guiones fallidos de más de 7 días plegados con el número de la base (${oldJobs})`, (await folded.count()) === 1 && sum.includes(`(${oldJobs})`), sum);
      ok(`[${dev}] el bloque plegado empieza cerrado y conserva las tarjetas dentro (no se borra nada)`, !(await folded.evaluate((d) => d.open)) && (await folded.locator("li").count()) === oldJobs);
    } else ok(`[${dev}] sin guiones antiguos en la base, no aparece el bloque plegado`, (await folded.count()) === 0);
  } else info(`[${dev}] #258 no desplegado: bloque plegado presente=${(await folded.count()) > 0}`);
  const nav = await p.locator("header a").evaluateAll((a) => a.map((x) => x.getAttribute("href")));
  ok(`[${dev}] navegación: el menú ofrece «Podcast»`, nav.includes("/dashboard/podcast"));
  await wide("Mis proyectos");
  await p.screenshot({ path: path.join(EVID, `${dev}-proyectos.png`), fullPage: true });

  // 2) Podcast: avatares guardados y proveedores (#259). Solo se usa el borrador local del navegador del smoke.
  r = await p.goto(`${APP}/dashboard/podcast`);
  ok(`[${dev}] /dashboard/podcast carga (HTTP ${r?.status()})`, r?.status() === 200 && !/\/login/.test(p.url()));
  await p.evaluate((k) => localStorage.removeItem(k), DRAFT); await p.reload();
  const W = p.getByTestId("podcast-wizard");
  await p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor();
  await W.getByTestId("modalidad-dialogo").click();
  const GA = W.getByTestId("avatares-guardados-A");
  if (has259) {
    if (avatars.length > 0) {
      const ids = await GA.locator('[data-testid^="avatar-guardado-A-"]').evaluateAll((b) => b.map((x) => x.getAttribute("data-testid").replace("avatar-guardado-A-", "")));
      ok(`[${dev}] los avatares guardados del dueño se ven junto al catálogo (${avatars.length})`, ids.length === avatars.length);
      ok(`[${dev}] ningún avatar ajeno`, ids.every((id) => ownAvatarIds.has(id)));
      const srcs = await GA.locator("img").evaluateAll((im) => im.map((x) => x.getAttribute("src") ?? ""));
      ok(`[${dev}] las fotos usan enlace firmado de la carpeta del dueño (${srcs.length} con foto)`, srcs.every((s) => /[?&]token=/.test(s) && s.includes(`/avatar-uploads/${OWNER}/`)), srcs.length);
    } else ok(`[${dev}] sin avatares listos, se explica cómo crear uno`, (await W.getByTestId("sin-avatares-guardados-A").count()) === 1);
  } else info(`[${dev}] #259 no desplegado: avatares guardados visibles=${(await GA.count()) > 0}`);
  // Pantalla Estilo abriendo el borrador LOCAL en ese paso (STEP.visuales = 6), sin pulsar «Siguiente» ni generar/estimar.
  await p.evaluate((k) => { const d = JSON.parse(localStorage.getItem(k) || "null"); if (d) { d.step = 6; localStorage.setItem(k, JSON.stringify(d)); } }, DRAFT);
  await p.reload(); await p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor();
  const rc = W.getByLabel("Ilustraciones Recraft");
  await rc.waitFor({ timeout: 15000 }).catch(() => {});
  if ((await rc.count()) > 0) {
    const avail = await W.getByTestId("proveedor-recraft").getAttribute("data-available");
    if (has259 && avail === "0") ok(`[${dev}] Recraft no disponible: deshabilitado y sin marcar`, (await rc.isDisabled()) && !(await rc.isChecked()));
    else info(`[${dev}] Recraft data-available=${avail} marcado=${await rc.isChecked()} deshabilitado=${await rc.isDisabled()}`);
  } else info(`[${dev}] no se llegó a la pantalla Estilo (el asistente pidió completar pasos previos); sin escrituras`);
  await p.evaluate((k) => localStorage.removeItem(k), DRAFT);
  await wide("Podcast");
  await p.screenshot({ path: path.join(EVID, `${dev}-podcast.png`), fullPage: true });

  // 3) Reproducción y descarga de un episodio existente (sin generar nada).
  if (readyStudio.length) {
    await p.goto(`${APP}/dashboard/podcast`);
    const card = p.getByTestId(`studio-episode-${readyStudio[0].id}`);
    const player = card.locator('[data-testid="studio-player"], [data-testid="studio-audio-player"]').first();
    await player.waitFor({ timeout: 30000 }).catch(() => {});
    const play = await player.evaluate(async (m) => { m.muted = true; await m.play().catch(() => {}); await new Promise((r) => setTimeout(r, 3000)); return { rs: m.readyState, t: m.currentTime, err: m.error ? m.error.code : null }; }).catch(() => null);
    ok(`[${dev}] el episodio listo más reciente se reproduce desde la biblioteca`, !!play && play.rs >= 2 && play.t > 1 && !play.err, play);
    const href = await card.locator('[data-testid="studio-download-mp4"], [data-testid="studio-download-audio"]').first().getAttribute("href").catch(() => null);
    ok(`[${dev}] la descarga es un enlace firmado de la carpeta del dueño`, !!href && /[?&]token=/.test(href) && href.includes(OWNER));
    if (href) {
      const res = await fetch(href, { headers: { Range: "bytes=0-1023" } }).catch(() => null);
      const type = res?.headers.get("content-type") ?? "";
      ok(`[${dev}] la descarga responde con audio o video (solo los primeros bytes)`, !!res && (res.status === 206 || res.status === 200) && /^(audio|video)\//.test(type), { status: res?.status, type });
      await res?.body?.cancel().catch(() => {});
    }
  } else info(`[${dev}] el dueño no tiene episodios de estudio listos sin archivar: reproducción/descarga no comprobable sin generar uno`);

  ok(`[${dev}] la página no envió escrituras (POST/PUT/PATCH/DELETE)`, writes.length === 0, writes.slice(0, 5));
  info(`[${dev}] telemetría Sentry enviada: ${telemetry.length}`);
  ok(`[${dev}] sin errores de JavaScript`, jsErrors.length === 0, jsErrors.slice(0, 5));
  await ctx.close();
}
await browser.close();
const after = await counts();
ok("la base no cambió (episodios, avatares, guiones, proyectos)", JSON.stringify(before) === JSON.stringify(after), { before, after });
console.log(`RESULT smoke-lanzamiento: ${fails === 0 ? "OK" : "FALLA"} pass=${passes} fail=${fails} nivel=${LEVEL}`);
process.exit(fails === 0 ? 0 : 1);
