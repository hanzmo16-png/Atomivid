// PRUEBA REAL CON GASTO, autorizada por Hans el 2026-10-31 con tope de USD 5 (presupuesto_usd del caso, MAX 5):
// un episodio NUEVO de Podcast Studio desde el asistente actual (4 pantallas), en PRODUCCIÓN, con la sesión del dueño,
// en móvil (Samsung 390×844):
//   Conversación · Valeria Montclair + Víctor Albarrán (catálogo, voz incluida) · guion de ~1,5 min · «Solo estudio y
//   anfitriones» (sin Recraft) · presupuesto = estimado +10 % redondeado a 0,5, nunca más de BUDGET_USD.
// Si la estimación +10 % supera el tope, NO se genera nada (FAIL). Después: progreso real hasta «Listo» (o fallo/tiempo),
// biblioteca, enlaces firmados del dueño, descarga del MP4 y del audio, duración, −16 LUFS / TP, costo real frente a
// estimado y autorizado, y el libro de operaciones (cada clave una sola vez, nada «reserved» o «uncertain» al final).
// Registro sin datos personales; el MP4 y fotogramas van cifrados a $EVID para la revisión visual de Hans.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const APP = "https://atomivid.vercel.app", HOST = new URL(APP).hostname, EVID = process.env.EVID;
const CAP = Number(process.env.BUDGET_USD);
if (!(CAP > 0 && CAP <= 5)) { console.log("FAIL pod-real: presupuesto_usd debe estar entre 0 y 5"); process.exit(1); }
fs.mkdirSync(EVID, { recursive: true });
let fails = 0;
const ok = (name, cond, info = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${info !== "" ? ` — ${typeof info === "string" ? info : JSON.stringify(info)}` : ""}`); if (!cond) fails++; return cond; };
const rest = async (table, query) => {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!r.ok) throw new Error(`lectura ${table} ${r.status}`);
  return r.json();
};
const activeCount = async () => (await rest("podcast_studio_episodes", "select=id&status=in.(authorized,generating)")).length;

// Guion de ~90 s (13,5 caracteres/s) con los nombres del catálogo; el asistente lo escribe tal cual.
const SCRIPT = [
  "Valeria Montclair: Bienvenidos a este episodio corto. Hoy hablamos de los sumerios y de la escritura más antigua que conocemos.",
  "Víctor Albarrán: Gracias, Valeria. Hace más de cinco mil años, en Mesopotamia, empezaron a marcar tablillas de arcilla con un punzón.",
  "Valeria Montclair: ¿Y qué escribían en esas tablillas? Imagino que historias de dioses y reyes.",
  "Víctor Albarrán: Sorprende, pero casi todo eran cuentas: cebada, ovejas, salarios y contratos. La escritura nació para administrar.",
  "Valeria Montclair: Entonces la contabilidad llegó antes que la literatura.",
  "Víctor Albarrán: Exacto. Siglos después aparecieron leyes, cartas y relatos como la epopeya de Gilgamesh.",
  "Valeria Montclair: Una idea práctica que terminó cambiando la historia. Gracias, Víctor.",
  "Víctor Albarrán: Gracias a ti, Valeria. Nos escuchamos en el próximo episodio.",
].join("\n");
const TITLE = `Los sumerios y la primera escritura (${new Date().toISOString().slice(0, 10)})`;

const before = await activeCount();
if (!ok("producciones activas = 0 antes de generar", before === 0, `${before}`)) { console.log("RESULT pod-real: FALLA (no se generó nada)"); process.exit(1); }

const st = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); st.cookies = (st.cookies ?? []).map((c) => ({ ...c, domain: HOST })); st.origins = [];
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, storageState: st, locale: "es-MX" });
await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
const p = await ctx.newPage(); p.setDefaultTimeout(60000);
const posts = []; p.on("response", async (r) => { if (r.request().method() === "POST" && r.url().startsWith(`${APP}/api/podcast/v3`)) posts.push({ path: new URL(r.url()).pathname, status: r.status(), body: await r.json().catch(() => null) }); });
const shot = (n) => p.screenshot({ path: path.join(EVID, `${n}.png`), fullPage: true });
const W = () => p.getByTestId("podcast-wizard");
const next = async () => { await W().getByRole("button", { name: "Siguiente" }).click(); await p.waitForTimeout(800); };

await p.goto(`${APP}/dashboard/podcast`);
await p.evaluate(() => localStorage.removeItem("atomivid.podcast.asistente.v2")); await p.reload();
await p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor();
// Pantalla 1 — Participantes.
await W().getByTestId("modalidad-dialogo").click();
await W().getByRole("radiogroup", { name: /Participante A/ }).getByTestId("anfitrion-valeria").getByRole("radio").click();
await W().getByRole("radiogroup", { name: /Participante B/ }).getByTestId("anfitrion-victor").getByRole("radio").click();
await shot("01-participantes");
await next();
// Pantalla 2 — Contenido: título, tema, 2 min de objetivo y el guion.
await W().getByLabel("Título del episodio").fill(TITLE);
await W().getByLabel("Tema").fill("Los sumerios y el origen de la escritura");
const slider = W().getByLabel("Duración en minutos"); await slider.focus();
for (let i = 0; i < 40 && Number(await slider.inputValue()) > 2; i++) await p.keyboard.press("ArrowLeft");
await W().getByLabel("Guion").fill(SCRIPT);
ok("objetivo de duración 2 min", (await slider.inputValue()) === "2", await slider.inputValue());
await shot("02-contenido");
await next();
// Pantalla 3 — Estilo: «Solo estudio y anfitriones» (sin Recraft ni imágenes de pago).
await W().getByLabel("Solo estudio y anfitriones (sin imágenes)").check();
ok("proveedor «Solo estudio» elegido", await W().getByLabel("Solo estudio y anfitriones (sin imágenes)").isChecked());
await shot("03-estilo");
await next();
// Pantalla 4 — Producir: estimación gratuita y presupuesto.
await W().getByTestId("wizard-estimate").locator("table").waitFor({ timeout: 90000 });
const estText = (await W().getByTestId("wizard-estimate").textContent()) ?? "";
const est = Number((/Total estimado\s*USD\s*([\d.]+)/.exec(estText)?.[1] ?? ""));
const budget = Math.ceil((est * 1.1) / 0.5) * 0.5;
console.log(`INFO estimado USD ${est} · presupuesto ${budget} · tope del caso ${CAP}`);
await shot("04-producir");
if (!ok("estimación válida y presupuesto (+10 %) dentro del tope autorizado", est > 0 && budget <= CAP, { est, budget, CAP })) {
  await browser.close(); console.log("RESULT pod-real: FALLA (no se generó nada)"); process.exit(1);
}
await W().getByLabel("Presupuesto máximo").fill(String(budget));
await W().getByLabel("Autorizo el cargo").check();
await shot("05-autorizacion");
await W().getByRole("button", { name: "Generar episodio" }).click();
// Creación (borrador) y autorización: dos POST a la API v3.
const t0 = Date.now();
for (let i = 0; i < 60 && posts.filter((x) => /\/api\/podcast\/v3\/[0-9a-f-]{36}$/.test(x.path)).length === 0; i++) await p.waitForTimeout(1000);
const created = posts.find((x) => x.path === "/api/podcast/v3" && x.body?.id);
const auth = posts.find((x) => /\/api\/podcast\/v3\/[0-9a-f-]{36}$/.test(x.path));
const id = created?.body?.id ?? auth?.path.split("/").pop();
ok("episodio creado y autorizado por la interfaz", !!id && auth?.status === 200, { create: created?.status, authorize: auth?.status, dispatched: auth?.body?.dispatched, note: auth?.body?.note });
if (!id) { await browser.close(); console.log("RESULT pod-real: FALLA"); process.exit(1); }
console.log(`INFO episodio ${String(id).slice(0, 8)}`);
const row0 = (await rest("podcast_studio_episodes", `select=status,estimated_usd,authorized_usd&id=eq.${id}`))[0];
ok("autorizado en la base con el presupuesto elegido (≤ tope)", Number(row0?.authorized_usd) === budget && budget <= CAP, row0);

// Progreso real: etapas observadas en la base (sin tocar nada) hasta «ready»/«failed» o 150 min.
const stages = [];
let row = null;
for (let i = 0; i < 300; i++) {
  row = (await rest("podcast_studio_episodes", `select=status,progress,error,cost_usd,video_path,audio_path,run_started_at,updated_at&id=eq.${id}`))[0];
  const stg = row?.progress?.stage ?? row?.status;
  if (stages[stages.length - 1]?.stage !== stg) { stages.push({ stage: stg, pct: row?.progress?.pct ?? null, min: Math.round((Date.now() - t0) / 6000) / 10 }); console.log(`INFO progreso ${JSON.stringify(stages[stages.length - 1])}`); }
  if (row?.status === "ready" || row?.status === "failed") break;
  await new Promise((r) => setTimeout(r, 30000));
}
const minutes = Math.round((Date.now() - t0) / 6000) / 10;
ok(`el episodio terminó «Listo» sin intervención (${minutes} min)`, row?.status === "ready", { status: row?.status, error: row?.error?.slice?.(0, 200) ?? null });
ok("el progreso avanzó por varias etapas", stages.length >= 3, stages.map((s) => s.stage).join(" → "));

// Biblioteca, reproducción y descarga desde la cuenta.
if (row?.status === "ready") {
  await p.goto(`${APP}/dashboard/podcast`);
  const card = p.getByTestId(`studio-episode-${id}`);
  ok("aparece en la biblioteca principal", (await card.count()) === 1);
  const player = card.locator('[data-testid="studio-player"]');
  await player.waitFor({ timeout: 30000 }).catch(() => {});
  const play = await player.evaluate(async (m) => { m.muted = true; await m.play().catch(() => {}); await new Promise((r) => setTimeout(r, 3000)); return { rs: m.readyState, t: m.currentTime, err: m.error ? m.error.code : null }; }).catch(() => null);
  ok("se reproduce desde la biblioteca (móvil)", !!play && play.rs >= 2 && play.t > 1 && !play.err, play);
  await shot("06-biblioteca");
  const mp4 = await card.getByTestId("studio-download-mp4").getAttribute("href").catch(() => null);
  const aud = await card.getByTestId("studio-download-audio").getAttribute("href").catch(() => null);
  ok("descargas firmadas MP4 y audio de la carpeta del dueño", !!mp4 && !!aud && /token=/.test(mp4) && /token=/.test(aud) && mp4.includes(String(id)) && aud.includes(String(id)));
  if (mp4) {
    const file = path.join(EVID, "episodio.mp4");
    fs.writeFileSync(file, Buffer.from(await (await fetch(mp4)).arrayBuffer()));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file]).toString());
    const dur = Number(probe.format?.duration);
    const scriptSecs = (SCRIPT.length / 13.5) + 5.5 + 8 * 0.4;
    ok("duración final coherente con el guion (±25 %)", Math.abs(dur - scriptSecs) / scriptSecs <= 0.25, { dur: Math.round(dur), esperado: Math.round(scriptSecs), size_mb: Math.round(fs.statSync(file).size / 1e5) / 10, streams: probe.streams });
    const out = execFileSync("bash", ["-c", `ffmpeg -hide_banner -nostats -i "${file}" -af ebur128=peak=true -f null - 2>&1 | tail -12`]).toString();
    const I = Number(/I:\s*(-?[\d.]+) LUFS/.exec(out)?.[1]), TP = Number(/Peak:\s*(-?[\d.]+) dBFS/.exec(out)?.[1]);
    ok("audio −16 ±1 LUFS y pico real ≤ −1 dBTP", Math.abs(I + 16) <= 1 && TP <= -1, { I, TP });
    for (const [n, t] of [["a", 5], ["b", Math.max(6, dur / 2)], ["c", Math.max(7, dur - 8)]]) execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", path.join(EVID, `fotograma-${n}.jpg`)]);
  }
}

// Costo y libro de operaciones.
const fin = (await rest("podcast_studio_episodes", `select=status,estimated_usd,authorized_usd,cost_usd&id=eq.${id}`))[0];
const ops = await rest("podcast_studio_operations", `select=key,provider,op,state,reserved_usd,actual_usd&episode_id=eq.${id}`);
const keys = new Set(ops.map((o) => o.key));
const byState = ops.reduce((m, o) => ({ ...m, [o.state]: (m[o.state] ?? 0) + 1 }), {});
const settled = ops.filter((o) => o.state === "settled").reduce((s, o) => s + Number(o.actual_usd ?? o.reserved_usd ?? 0), 0);
console.log(`INFO costo estimado ${fin?.estimated_usd} · autorizado ${fin?.authorized_usd} · real ${fin?.cost_usd} · liquidado en libro ${Math.round(settled * 1e4) / 1e4} · operaciones ${JSON.stringify(byState)}`);
ok("costo real ≤ autorizado ≤ tope del caso", Number(fin?.cost_usd ?? 0) <= Number(fin?.authorized_usd) + 1e-9 && Number(fin?.authorized_usd) <= CAP, fin);
ok("sin doble cargo: cada clave del libro una sola vez", keys.size === ops.length, `${ops.length} operaciones`);
if (row?.status === "ready") ok("nada queda reservado o incierto al terminar", !byState.reserved && !byState.uncertain, byState);
ok("producciones activas = 0 al final", (await activeCount()) === 0);
await browser.close();
console.log(`RESULT pod-real: ${fails === 0 ? "OK" : "FALLA"} fails=${fails} min=${minutes}`);
process.exit(fails === 0 ? 0 : 1);
