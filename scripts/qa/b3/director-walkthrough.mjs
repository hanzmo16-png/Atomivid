/**
 * T-34 B3 — recorrido REAL (Chromium + rutas de la app + Supabase LOCAL) de «Director solicitado vs aplicado» en Reels,
 * con la separación web/worker reproducida en una máquina:
 *   - web: `next dev` local con el Director encendido para la cuenta piloto sintética y el despacho a GitHub
 *     interceptado en el propio proceso (gh-dispatch-intercept.mjs: nada sale de la máquina);
 *   - worker: proceso aparte (run-worker.ts) con SU entorno, que puede coincidir o no con el de la web.
 * Proveedores fixture (material sintético), Anthropic emulado. Rechaza cualquier app o Supabase no local.
 *
 *   node scripts/qa/b3/director-walkthrough.mjs --out=<dir> [--app=http://localhost:3000] --dispatch-log=<archivo>
 *
 * Escenarios:
 *   1 positivo: web ON + worker ON + cuenta piloto ⇒ MP4 + director.json del intento final + «recetas aplicadas».
 *   2 divergencia: web ON + worker OFF ⇒ bloqueo antes de reservar/pagar, mensaje accionable, sin MP4 ni montaje clásico.
 *   3 cuenta no piloto: la web no solicita ⇒ montaje clásico, sin panel ni aviso del Director.
 *   4 evidencia ausente: se borra el director.json del escenario 1 ⇒ la página deja de decir «aplicado» y lo explica.
 */
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const OUT = arg("out", "b3-out");
const APP = arg("app", "http://localhost:3000").replace(/\/$/, "");
const DISPATCH_LOG = arg("dispatch-log", "");
const SB = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const OWNER_EMAIL = process.env.B3_OWNER_EMAIL ?? "b3-owner@local.test";
const isLocal = (u) => { try { return ["localhost", "127.0.0.1"].includes(new URL(u).hostname); } catch { return false; } };
if (!isLocal(APP) || !isLocal(SB) || !ANON || !SERVICE || !DISPATCH_LOG) {
  console.error("B3: REFUSED — app y Supabase locales, claves locales y --dispatch-log son obligatorios.");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const results = [];
const notVerified = [];
const log = (...a) => { const l = `[${new Date().toISOString()}] ${a.join(" ")}`; console.log(l); fs.appendFileSync(`${OUT}/run.log`, l + "\n"); };
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail)); };
const admin = (path, init = {}) => fetch(`${SB}${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
const rows = async (path) => (await admin(path)).json();

async function makeUser(email) {
  const list = await rows(`/auth/v1/admin/users?per_page=1000`);
  for (const u of list.users ?? []) if (u.email === email) await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  const password = `B3-${randomUUID()}`;
  const r = await admin("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) });
  if (!r.ok) throw new Error(`crear usuario: HTTP ${r.status}`);
  const id = (await r.json()).id;
  // Suscripción SINTÉTICA solo en la base local (sin Stripe).
  await admin("/rest/v1/subscriptions", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: id, status: "active", price_id: null }) });
  return { email, password, id };
}

const browser = await chromium.launch({ executablePath: CHROMIUM });
let shotN = 0;
const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/${String(++shotN).padStart(2, "0")}-${name}.png`, fullPage: true }).catch(() => {}); };
async function login(u) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180_000);
  await page.goto(`${APP}/login`, { waitUntil: "networkidle" });
  await page.fill("#email", u.email);
  await page.fill("#password", u.password);
  await Promise.all([page.waitForURL(/\/dashboard/), page.getByRole("button", { name: "Iniciar sesión" }).click()]);
  return { ctx, page };
}
const dismissTour = async (page) => { const b = page.getByRole("button", { name: "Omitir" }); if (await b.count()) await b.first().click(); };
async function createReel(page, topic) {
  await page.goto(`${APP}/dashboard/new`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await dismissTour(page);
  const reel = page.getByRole("button", { name: /Reel \/ Short/ });
  if (await reel.count()) await reel.first().click();
  await page.fill("#topic", topic);
  await page.selectOption("#style", { index: 1 });
  const dur = page.getByRole("radio", { name: "30s" });
  if (await dur.count()) await dur.click();
  await Promise.all([page.waitForURL(/\/dashboard\?created=1|\/dashboard\/new\?error=/), page.locator("form button[type=submit]").last().click()]);
}
async function scriptToReview(page, topic) {
  const cardOf = () => page.locator("article, li, div").filter({ hasText: topic }).filter({ has: page.getByRole("button", { name: /Generar guion|Reintentar/ }).or(page.locator('a[href*="/dashboard/review/"]')) }).last();
  await cardOf().getByRole("button", { name: /Generar guion/ }).click();
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    if (/\/dashboard\/review\//.test(page.url())) return new URL(page.url()).pathname;
    await page.reload({ waitUntil: "networkidle" });
    const link = cardOf().locator('a[href*="/dashboard/review/"]');
    if (await link.count()) return link.first().getAttribute("href");
  }
  throw new Error("sin guion");
}
const dispatchesFor = (id) => (fs.existsSync(DISPATCH_LOG) ? fs.readFileSync(DISPATCH_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((d) => d.payload?.requestId === id);

/** Worker as a separate process with its own environment (the Actions side). */
function runWorker(id, attempt, workerEnv) {
  const env = { ...process.env, ...workerEnv };
  for (const k of ["NODE_OPTIONS", "B3_DISPATCH_LOG", "CINEMATIC_DIRECTOR_V2_ENABLED"]) delete env[k];
  for (const [k, v] of Object.entries(workerEnv)) if (v === null) delete env[k];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/qa/b3/run-worker.ts", id, String(attempt)], { env, encoding: "utf8", timeout: 900_000 });
  fs.writeFileSync(`${OUT}/worker-${id.slice(0, 8)}-${attempt}.log`, (r.stdout ?? "") + (r.stderr ?? ""));
  log("worker", id.slice(0, 8), "attempt", attempt, "exit", r.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return r;
}
async function requestRow(id) { return (await rows(`/rest/v1/video_requests?select=status,render_attempts,error_message,video_path,director_requested,progress_stage&id=eq.${id}`))[0]; }
async function storageList(prefix) {
  const r = await admin(`/storage/v1/object/list/videos`, { method: "POST", body: JSON.stringify({ prefix, limit: 100 }) });
  return r.ok ? (await r.json()).map((o) => o.name) : [];
}
async function reservations(id) {
  const r = await admin(`/rest/v1/pi_supply_job_reservations?select=provider,status,consumed_usd&project_id=eq.${id}`);
  return r.ok ? await r.json() : null;
}

/** Create → script → review (checks the pre-render wording) → «Generar video final» → dispatch recorded. */
async function startRender(page, topic, label, expectEligible) {
  await createReel(page, topic);
  const review = await scriptToReview(page, topic);
  const id = review.split("/").pop();
  await page.goto(`${APP}${review}`, { waitUntil: "networkidle" });
  await shot(page, `${label}-revision`);
  // The panel is a collapsed <details>: read its full text, not only what is visible.
  const panel = page.locator('[data-testid="director-inspection"]');
  const panelText = (await panel.count()) ? await panel.first().evaluate((el) => el.textContent ?? "") : "";
  if (expectEligible) {
    check(`${label}: Revisión dice «elegible · se solicitará», nunca «aplicado»`, /Estado antes del render: elegible · se solicitará al generar/.test(panelText) && !/\baplicado\b/i.test(panelText.replace(/recetas aplicadas/g, "")), panelText.match(/Estado antes del render:[^.]*/)?.[0]);
  } else {
    check(`${label}: Revisión sin panel del Director (cuenta no piloto)`, panelText === "");
  }
  await page.getByRole("button", { name: "Generar video final" }).click();
  await page.waitForURL(/\/dashboard(\?|$)/, { timeout: 120_000 });
  const d = dispatchesFor(id);
  check(`${label}: la web despachó una vez (interceptado, sin red) con requestId e intento`, d.length === 1 && d[0].event === "render-video" && d[0].payload.renderAttempt === 1, d.map((x) => ({ event: x.event, attempt: x.payload.renderAttempt, hasDirectorField: JSON.stringify(x.payload).includes("director") })));
  check(`${label}: el payload del despacho no transporta ningún campo del Director`, d.every((x) => !/director/i.test(JSON.stringify(x.payload))));
  const row = await requestRow(id);
  check(`${label}: la fila guarda director_requested=${expectEligible}`, row.director_requested === expectEligible && row.status === "processing", row);
  return id;
}
async function probeMp4(path, label) {
  const url = `${SB}/storage/v1/object/videos/${path}`;
  const r = await admin(url.replace(SB, ""));
  const file = `${OUT}/${label}.mp4`;
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames,avg_frame_rate:format=duration", "-of", "json", file], { encoding: "utf8" }));
  fs.rmSync(file); // material sintético, pero el MP4 no sale de la máquina ni se guarda en la evidencia
  const v = probe.streams.find((s) => s.codec_type === "video"), au = probe.streams.find((s) => s.codec_type === "audio");
  return { video: v?.codec_name, audio: au?.codec_name, w: v?.width, h: v?.height, frames: Number(v?.nb_read_frames), fps: v?.avg_frame_rate, duration: Number(probe.format?.duration) };
}

const WORKER_ON = { CINEMATIC_DIRECTOR_RENDER_ENABLED: "true", CINEMATIC_DIRECTOR_PILOT_EMAILS: OWNER_EMAIL };
const WORKER_OFF = { CINEMATIC_DIRECTOR_RENDER_ENABLED: null, CINEMATIC_DIRECTOR_PILOT_EMAILS: OWNER_EMAIL };
try {
  const owner = await makeUser(OWNER_EMAIL);
  const other = await makeUser(`b3-other-${Date.now()}@local.test`);
  const a = await login(owner);

  // ── 1 positivo ─────────────────────────────────────────────────────────────────────────────────────────────
  const id1 = await startRender(a.page, "Por qué el cielo es azul", "1-positivo", true);
  runWorker(id1, 1, WORKER_ON);
  const r1 = await requestRow(id1);
  check("1-positivo: el intento termina completed con video_path del intento 1", r1.status === "completed" && /\/attempt-1\/final\.mp4$/.test(r1.video_path ?? ""), { status: r1.status, path: r1.video_path?.replace(id1, "<id>") });
  const files1 = await storageList(`${id1}/attempt-1`).catch(() => []);
  const prefix1 = r1.video_path?.slice(0, r1.video_path.lastIndexOf("/"));
  const recRes = await admin(`/storage/v1/object/videos/${prefix1}/director.json`);
  const rec = recRes.ok ? await recRes.json() : null;
  check("1-positivo: director.json del intento final, ok y vinculado al MP4 (prefijo y duración)", rec?.ok === true && rec.artifactPrefix === prefix1 && typeof rec.durationSeconds === "number" && Array.isArray(rec.applied) && rec.applied.length > 0, { ok: rec?.ok, prefixMatches: rec?.artifactPrefix === prefix1, durationSeconds: rec?.durationSeconds, shots: rec?.applied?.length, files: files1.length });
  const intervals = (rec?.applied ?? []).map((x) => [x.shotId, x.recipeId, x.applied.startSeconds, x.applied.endSeconds]);
  fs.writeFileSync(`${OUT}/1-recetas-aplicadas.json`, JSON.stringify(intervals, null, 2));
  const mp4 = r1.video_path ? await probeMp4(r1.video_path, "1-positivo") : null;
  check("1-positivo: MP4 H264/AAC 1080x1920 con fotogramas reales", mp4?.video === "h264" && mp4?.audio === "aac" && mp4.w === 1080 && mp4.h === 1920 && mp4.frames > 0, mp4);
  const last = intervals.at(-1)?.[3];
  check("1-positivo: cada receta tiene plano e intervalo dentro del MP4 (orden, sin solapes)", intervals.length > 0 && intervals.every(([, , s, e], i) => e > s && (i === 0 || s >= intervals[i - 1][3] - 0.05)) && last <= mp4.duration + 0.1, { shots: intervals.length, lastEnd: last, mp4Duration: mp4?.duration });
  await a.page.goto(`${APP}/dashboard/videos/${id1}`, { waitUntil: "networkidle" });
  await shot(a.page, "1-positivo-video");
  const page1 = await a.page.locator("body").innerText();
  check("1-positivo: la página del video muestra «Director: recetas aplicadas (N planos)» con N = registro", new RegExp(`Director: recetas aplicadas \\(${rec?.applied?.length} planos\\)`).test(page1));
  const canPlay = await a.page.evaluate(() => document.createElement("video").canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"'));
  if (!canPlay) notVerified.push({ name: "reproducción dentro de este Chromium", reason: "sin H264/AAC (canPlayType vacío); el MP4 se verificó con ffprobe" });

  // ── 2 divergencia: web ON, worker OFF ─────────────────────────────────────────────────────────────────────────
  const id2 = await startRender(a.page, "Cómo vuelan los aviones", "2-divergencia", true);
  runWorker(id2, 1, WORKER_OFF);
  const r2 = await requestRow(id2);
  check("2-divergencia: el intento falla con el bloqueo del Director (sin montaje clásico)", r2.status === "failed" && !r2.video_path && /Pediste el Director/.test(r2.error_message ?? ""), { status: r2.status, video_path: r2.video_path, msg: (r2.error_message ?? "").slice(0, 160) });
  const files2 = await storageList(`${id2}/attempt-1`);
  check("2-divergencia: ningún artefacto pagado (voz, escenas, música, MP4) en el almacenamiento del intento", files2.length === 0, { files: files2 });
  const res2 = await reservations(id2);
  if (res2 === null) notVerified.push({ name: "2-divergencia: estado de reservas", reason: "tabla de reservas no legible en esta base local" });
  else check("2-divergencia: ninguna reserva de suministro queda abierta ni consumida", res2.every((x) => x.status !== "OPEN" && Number(x.consumed_usd) === 0), res2);
  await a.page.goto(`${APP}/dashboard/videos/${id2}`, { waitUntil: "networkidle" });
  await shot(a.page, "2-divergencia-video");
  const page2 = await a.page.locator("body").innerText();
  check("2-divergencia: la página explica qué pasó y qué hacer, sin nombres internos", /Pediste el Director/.test(page2) && /No se reservó ni se cobró nada/.test(page2) && /Qué hacer/.test(page2) && !/CINEMATIC_|PILOT_EMAILS/.test(page2) && (await a.page.locator("video").count()) === 0, page2.split("\n").find((l) => /Pediste el Director/.test(l))?.slice(0, 300));
  check("2-divergencia: nunca «recetas aplicadas»", !/recetas aplicadas/.test(page2));

  // ── 3 cuenta no piloto ───────────────────────────────────────────────────────────────────────────────────────
  const b = await login(other);
  const id3 = await startRender(b.page, "Por qué el mar es salado", "3-no-piloto", false);
  runWorker(id3, 1, WORKER_ON);
  const r3 = await requestRow(id3);
  const recRes3 = r3.video_path ? await admin(`/storage/v1/object/videos/${r3.video_path.slice(0, r3.video_path.lastIndexOf("/"))}/director.json`) : null;
  check("3-no-piloto: montaje clásico completado, sin director.json aunque el worker esté encendido", r3.status === "completed" && recRes3 && !recRes3.ok, { status: r3.status, directorJson: recRes3?.status });
  await b.page.goto(`${APP}/dashboard/videos/${id3}`, { waitUntil: "networkidle" });
  const page3 = await b.page.locator("body").innerText();
  check("3-no-piloto: sin panel ni aviso del Director", !/recetas aplicadas|Director solicitado/.test(page3));

  // ── 4 evidencia ausente ──────────────────────────────────────────────────────────────────────────────────────
  const del = await admin(`/storage/v1/object/videos`, { method: "DELETE", body: JSON.stringify({ prefixes: [`${prefix1}/director.json`] }) });
  await a.page.goto(`${APP}/dashboard/videos/${id1}`, { waitUntil: "networkidle" });
  await shot(a.page, "4-sin-evidencia");
  const page4 = await a.page.locator("body").innerText();
  check("4-sin-evidencia: sin director.json la página deja de decir «aplicado» y lo explica", del.ok && !/recetas aplicadas/.test(page4) && /Director solicitado, sin evidencia de aplicación en este video/.test(page4), { deleted: del.status });
  await a.ctx.close();
  await b.ctx.close();
} catch (e) {
  check("recorrido sin excepciones", false, String(e?.message ?? e).split("\n")[0].slice(0, 300));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
fs.writeFileSync(`${OUT}/b3-report.json`, JSON.stringify({ kind: "ATOMIVID_B3_DIRECTOR_WALKTHROUGH", at: new Date().toISOString(), app: APP, label: failed ? "FAIL" : "LOCAL_PASS (rutas reales, material sintético)", passed: results.length - failed, failed, notVerified, results }, null, 2));
log(`B3: ${results.length - failed}/${results.length} PASS`);
process.exitCode = failed ? 1 : 0;
