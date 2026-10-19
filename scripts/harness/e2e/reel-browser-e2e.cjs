/**
 * E2E REAL de navegador (T-20261019-1553, Grok). Next local + Playwright/Chromium headless + Postgres local vía PostgREST
 * real + gateway Supabase-compatible (auth/storage) + mock Anthropic + worker de prueba que ejecuta scripts/render-worker.ts.
 * USD 0: ninguna salida fuera de 127.0.0.1 (next-intercept.cjs la rechaza y la registra). Sin filas precargadas de solicitudes:
 * todo nace del formulario. Cada comprobación es una aserción; cualquier fallo ⇒ exit 1.
 *
 *   E2E_OUT=<dir> E2E_DIR=<dir del arnés> node reel-browser-e2e.cjs
 */
const path = require("node:path"), fs = require("node:fs"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const PW = process.env.PLAYWRIGHT_MODULE ?? "playwright"; const { chromium } = require(PW);
const { Client } = require(process.env.HARNESS_PG_MODULE ?? "pg");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
const OUT = path.resolve(process.env.E2E_OUT ?? "e2e-out"); const HD = path.resolve(process.env.E2E_DIR ?? "."); const LOGS = path.join(HD, "logs"), STORE = path.join(HD, "storage");
fs.mkdirSync(OUT, { recursive: true });
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const OTHER = { id: "22222222-2222-4222-8222-222222222222", email: "intruso@local.test", password: "local-pass-other-2" };
const checks = []; const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail).slice(0, 400)}`); return !!ok; };
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const jsonl = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let db;
const row = async (id) => (await db.query("select * from public.video_requests where id=$1", [id])).rows[0];

async function session(user, tag) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: path.join(OUT, `video-${tag}`), size: { width: 1280, height: 900 } }, acceptDownloads: true });
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const p = await ctx.newPage(); p.setDefaultTimeout(120000);
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", user.email); await p.fill("input[name=password]", user.password);
  await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
  return { ctx, p, tag };
}
async function closeSession(s) { await s.ctx.tracing.stop({ path: path.join(OUT, `trace-${s.tag}.zip`) }); await s.ctx.close(); }
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `${n}.png`), fullPage: true });
const skipTour = (p) => p.getByRole("button", { name: "Omitir" }).click({ timeout: 8000 }).catch(() => {});

async function createReel(p, topic, tag) {
  await p.goto(`${BASE}/dashboard/new`); await skipTour(p);
  await p.getByText("Reel / Short").click();
  await p.fill("#topic", topic); await p.selectOption("#language", "es").catch(() => {});
  await p.selectOption("#style", { label: "Curiosidades" }); await p.getByText("30s", { exact: true }).click();
  await p.getByText("Puedes continuar", { exact: false }).first().waitFor({ timeout: 60000 }).catch(() => {});
  await shot(p, `${tag}-01-formulario`);
  await p.getByRole("button", { name: "Crear solicitud" }).click(); await p.waitForURL(/created=1/);
  await shot(p, `${tag}-02-creada`);
  const r = (await db.query("select * from public.video_requests where user_id=$1 and topic=$2", [OWNER.id, topic])).rows;
  check(`[${tag}] formulario crea exactamente 1 solicitud con la configuración pedida`, r.length === 1 && r[0].style === "Curiosidades" && r[0].duration_seconds === 30 && r[0].language === "es" && r[0].mode === "visual" && r[0].status === "pending",
    r.map((x) => ({ style: x.style, d: x.duration_seconds, lang: x.language, mode: x.mode, status: x.status })));
  const id = r[0].id;
  const before = jsonl(path.join(LOGS, "anthropic.jsonl")).length;
  await skipTour(p);
  await p.getByRole("button", { name: "Generar guion" }).first().click(); await p.waitForURL(new RegExp(`/dashboard/review/${id}`));
  await p.getByRole("button", { name: "Generar video final" }).waitFor();
  await shot(p, `${tag}-03-revision`);
  const v = await row(id); const after = jsonl(path.join(LOGS, "anthropic.jsonl")).length;
  check(`[${tag}] revisión: guion listo desde el mock (1 llamada), 0 render aún`, v.status === "script_ready" && Array.isArray(v.script_json?.segments) && v.script_json.segments.length >= 3 && after - before === 1 && v.render_attempts === 0,
    { status: v.status, segs: v.script_json?.segments?.length, calls: after - before, attempts: v.render_attempts });
  return id;
}
async function waitTerminal(id, ms = 12 * 60000) { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await row(id); if (["completed", "failed"].includes(v.status)) return v; await sleep(3000); } return v; }
const dispatchesFor = (id) => jsonl(path.join(LOGS, "dispatches.jsonl")).filter((d) => d.payload?.requestId === id || (d.tag ?? "").startsWith(id));
function ffprobe(f) { return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", f]).toString()); }
const setWorkerOverride = (o) => fs.writeFileSync(path.join(LOGS, "worker-env-override.json"), JSON.stringify(o));

let browser;
(async () => {
  db = new Client({ connectionString: process.env.HARNESS_PG_URL }); await db.connect();
  // Chrome for Testing (headless shell) porque el Chromium de Playwright no trae H.264/AAC (canPlayType vacío).
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined }); setWorkerOverride({});
  const run = Date.now();
  // ───── A. Camino del dueño con respuesta perdida ─────
  const A = await session(OWNER, "A-owner");
  const idA = await createReel(A.p, `E2E Director pulpo tres corazones ${run}`, "A");
  let intercepted = 0;
  await A.p.route("**/api/generate/*/render", async (route) => {
    if (route.request().method() !== "POST" || intercepted > 0) return route.continue();
    intercepted++; const resp = await route.fetch(); // el servidor procesa de verdad…
    fs.writeFileSync(path.join(OUT, "A-lost-response-server-status.txt"), `${resp.status()}\n${(await resp.text()).slice(0, 2000)}`);
    await route.abort("connectionreset"); // …y la respuesta no llega al navegador
  });
  await A.p.getByRole("button", { name: "Generar video final" }).click();
  await sleep(4000); await shot(A.p, "A-04-respuesta-perdida");
  const uiAfterLoss = await A.p.locator("main").innerText();
  const serverStatus = Number(fs.readFileSync(path.join(OUT, "A-lost-response-server-status.txt"), "utf8").split("\n")[0]);
  check("[A] respuesta perdida: el servidor aceptó (2xx) pero el navegador no recibió respuesta", intercepted === 1 && serverStatus >= 200 && serverStatus < 300, { intercepted, serverStatus });
  // Recuperación: el usuario recarga y, si ve el botón, vuelve a pulsar; nunca debe nacer un 2.º intento.
  await A.p.reload(); await skipTour(A.p); await sleep(2000); await shot(A.p, "A-05-tras-recargar");
  const retryBtn = A.p.getByRole("button", { name: "Generar video final" });
  let retried = false, retryStatus = null;
  if (await retryBtn.isVisible().catch(() => false) && await retryBtn.isEnabled().catch(() => false)) {
    retried = true; const [resp] = await Promise.all([A.p.waitForResponse((r) => /\/render$/.test(r.url()) && r.request().method() === "POST"), retryBtn.click()]); retryStatus = resp.status();
  }
  // Reintento forzado (doble clic / otra pestaña) contra la misma ruta: no debe crear otro intento ni otro despacho.
  const forced = await A.p.evaluate(async (id) => { const r = await fetch(`/api/generate/${id}/render`, { method: "POST" }); return { s: r.status, b: (await r.text()).slice(0, 300) }; }, idA);
  fs.writeFileSync(path.join(OUT, "A-forced-retry.json"), JSON.stringify(forced));
  check("[A] reintento forzado tras la pérdida: respuesta controlada (sin 5xx); el nº de intentos/despachos se asierta abajo", forced.s < 500, forced);
  await A.p.goto(`${BASE}/dashboard`); await sleep(1500); await shot(A.p, "A-06-panel-en-proceso");
  const vA = await waitTerminal(idA);
  const dA = dispatchesFor(idA).filter((d) => d.event_type === "render-video");
  check("[A] recuperación: 1 solo despacho y 1 solo intento pese a la respuesta perdida", dA.length === 1 && dA[0].payload.renderAttempt === 1 && vA.render_attempts === 1, { dispatches: dA.map((d) => d.payload), attempts: vA.render_attempts, retried, retryStatus, uiAfterLoss: uiAfterLoss.slice(0, 300) });
  check("[A] despacho al worker de prueba con el entrypoint productivo y salida 0", dispatchesFor(idA).some((d) => d.kind === "worker_exit" && d.tag === `${idA}-a1` && d.code === 0), dispatchesFor(idA));
  check("[A] solicitud completed con video_path del MISMO intento", vA.status === "completed" && vA.video_path === `${idA}/attempt-1/final.mp4`, { status: vA.status, video_path: vA.video_path, err: vA.error_message });
  check("[A] Director pedido conservado (director_requested=true) y configuración intacta", vA.director_requested === true && vA.style === "Curiosidades" && vA.duration_seconds === 30 && vA.language === "es" && vA.mode === "visual", { dr: vA.director_requested });
  const mp4 = path.join(STORE, "videos", idA, "attempt-1", "final.mp4"), dj = path.join(STORE, "videos", idA, "attempt-1", "director.json");
  const objs = fs.existsSync(path.join(STORE, "videos", idA)) ? fs.readdirSync(path.join(STORE, "videos", idA)) : [];
  const attempts = objs.filter((o) => o.startsWith("attempt-"));
  const paid = fs.existsSync(path.join(STORE, "videos", idA, "paid")) ? fs.readdirSync(path.join(STORE, "videos", idA, "paid")) : [];
  check("[A] MP4 y director.json existen bajo attempt-1/ y no hay otros intentos (paid/ sólo guarda el guion pagado)", fs.existsSync(mp4) && fs.existsSync(dj) && attempts.length === 1 && attempts[0] === "attempt-1" && objs.every((o) => o === "attempt-1" || o === "paid") && paid.every((f) => f.endsWith(".script.json")), { objs, paid });
  let director = null; try { director = JSON.parse(fs.readFileSync(dj, "utf8")); } catch {}
  check("[A] director.json ok=true con planos aplicados = planos del plan", director?.ok === true && (director.applied?.length ?? 0) > 0 && director.applied.length === director.plan?.shots?.length, { ok: director?.ok, applied: director?.applied?.length, plan: director?.plan?.shots?.length });
  const uploads = jsonl(path.join(LOGS, "gateway.jsonl")).filter((g) => g.kind === "upload" && g.key.startsWith(`videos/${idA}/`));
  const mp4Up = uploads.filter((u) => u.key.endsWith("final.mp4")), djUp = uploads.filter((u) => u.key.endsWith("director.json"));
  check("[A] el MP4 y director.json se subieron una sola vez, en el mismo intento, con el hash almacenado", mp4Up.length === 1 && djUp.length === 1 && mp4Up[0].sha256 === sha(mp4) && djUp[0].sha256 === sha(dj), { mp4Up, djUp });
  const pr = ffprobe(mp4); const vs = pr.streams.find((s) => s.codec_type === "video"), as = pr.streams.find((s) => s.codec_type === "audio"); const dur = Number(pr.format.duration);
  check("[A] MP4 H.264 1080x1920 + AAC, duración coherente con 30 s pedidos (±25 %)", vs?.codec_name === "h264" && vs.width === 1080 && vs.height === 1920 && as?.codec_name === "aac" && dur >= 22.5 && dur <= 37.5, { v: vs && [vs.codec_name, vs.width, vs.height], a: as?.codec_name, dur });
  // Reproducción y descarga desde la UI
  await A.p.goto(`${BASE}/dashboard/videos/${idA}`); await skipTour(A.p);
  const video = A.p.locator("video").first(); await video.waitFor();
  await A.p.evaluate(() => { const v = document.querySelector("video"); v.muted = true; return v.play(); });
  const t0 = await video.evaluate((v) => v.currentTime); await sleep(3000);
  const st = await video.evaluate((v) => ({ t: v.currentTime, paused: v.paused, rs: v.readyState, dur: v.duration, err: v.error && v.error.code, w: v.videoWidth, h: v.videoHeight }));
  await shot(A.p, "A-07-reproduccion");
  check("[A] reproducción en la UI: currentTime avanza ≥ 2 s, sin error, 1080x1920", st.t - t0 >= 2 && !st.paused && !st.err && st.w === 1080 && st.h === 1920, { t0, ...st });
  const [dl] = await Promise.all([A.p.waitForEvent("download"), A.p.getByRole("link", { name: /Descargar video/ }).click()]);
  const dlPath = path.join(OUT, "A-descarga.mp4"); await dl.saveAs(dlPath);
  check("[A] descarga desde la UI: sha256 idéntico al artefacto almacenado", sha(dlPath) === sha(mp4), { dl: sha(dlPath), stored: sha(mp4) });
  await closeSession(A);

  // ───── B. Otra cuenta ─────
  const B = await session(OTHER, "B-other");
  const resp = await B.p.goto(`${BASE}/dashboard/videos/${idA}`); await shot(B.p, "B-01-video-ajeno");
  const html = await B.p.content();
  check("[B] otra cuenta: página del video ajeno → 404 sin <video> ni URL firmada", resp.status() === 404 && !(await B.p.locator("video").count()) && !/object\/sign\//.test(html), { status: resp.status() });
  const rv = await B.p.goto(`${BASE}/dashboard/review/${idA}`); await shot(B.p, "B-02-revision-ajena");
  const rvText = await B.p.locator("body").innerText();
  // Diseño de la ruta: una revisión ajena redirige a /dashboard (redirect("/dashboard") en review/[id]/page.tsx); se exige que no filtre datos.
  check("[B] otra cuenta: revisión ajena denegada (404 o redirección al propio panel) sin filtrar el guion", (rv.status() === 404 || new URL(B.p.url()).pathname === "/dashboard") && !rvText.includes(`pulpo tres corazones ${run}`) && !(await B.p.locator("#director-material-usd").count()), { status: rv.status(), url: B.p.url() });
  const api = await B.p.evaluate(async (id) => { const r = await fetch(`/api/generate/${id}/render`, { method: "POST" }); return { s: r.status, b: (await r.text()).slice(0, 200) }; }, idA);
  const vAfter = await row(idA);
  check("[B] otra cuenta: POST /render ajeno rechazado (4xx) y la solicitud no cambia", api.s >= 400 && api.s < 500 && vAfter.render_attempts === 1 && vAfter.status === "completed", { api, attempts: vAfter.render_attempts });
  const rest = await B.p.evaluate(async () => (await fetch("/dashboard")).status);
  const leak = await B.p.locator("body").innerText(); check("[B] el panel de la otra cuenta no lista la solicitud ajena", !leak.includes(`pulpo tres corazones ${run}`) && rest === 200, {});
  await closeSession(B);

  // ───── C. Director no disponible en el worker ⇒ rechazo explícito, sin montaje clásico ─────
  const C = await session(OWNER, "C-director-unavailable");
  const idC = await createReel(C.p, `E2E Director no disponible ${run}`, "C");
  // E2E_RED=1: control negativo — sin la indisponibilidad inyectada, las aserciones de C deben FALLAR.
  if (process.env.E2E_RED !== "1") setWorkerOverride({ CINEMATIC_DIRECTOR_PILOT_EMAILS: "otra-persona@local.test" });
  await C.p.getByRole("button", { name: "Generar video final" }).click();
  const vC = await waitTerminal(idC, 5 * 60000); setWorkerOverride({});
  await C.p.goto(`${BASE}/dashboard`); await sleep(1500); await shot(C.p, "C-04-rechazo-explicito");
  const uiC = await C.p.locator("main").innerText();
  const objC = fs.existsSync(path.join(STORE, "videos", idC)) ? execFileSync("find", [path.join(STORE, "videos", idC), "-type", "f"]).toString().trim().split("\n").filter(Boolean) : [];
  const resC = (await db.query("select * from public.pi_supply_job_reservations where project_id=$1", [idC])).rows;
  check("[C] Director pedido pero no disponible en el worker ⇒ failed con mensaje explícito del Director", vC.status === "failed" && vC.director_requested === true && /Director/i.test(String(vC.error_message)) && !vC.video_path, { status: vC.status, err: vC.error_message });
  const mediaC = objC.filter((f) => !/\/paid\/[^/]+\.script\.json$/.test(f));
  check("[C] sin montaje clásico de sustitución: 0 MP4 / 0 director.json / 0 objetos de intento (sólo el guion pagado)", mediaC.length === 0 && !objC.some((f) => /final\.mp4$|director\.json$/.test(f)), { objC });
  check("[C] la UI muestra el rechazo explícito del Director (sin «completado»)", /Pediste el Director/.test(uiC), { ui: uiC.slice(0, 600) });
  check("[C] reservas de esta solicitud liberadas o inexistentes", resC.every((r) => r.status !== "OPEN"), resC.map((r) => r.status));
  await closeSession(C);

  // ───── Egreso ─────
  const egress = jsonl(path.join(LOGS, "egress.jsonl")).filter((e) => e.kind === "egress_refused" && Date.parse(e.at) >= run);
  // El interceptor rechaza toda salida no loopback; se exige además que ninguna fuera hacia un proveedor real (los mocks loopback la atendieron).
  check("Egreso: 0 salidas reales; ningún intento hacia api.anthropic.com/api.openai.com/api.github.com quedó sin desviar", !egress.some((e) => /anthropic|openai|github/.test(e.host ?? "")), { refused: egress.map((e) => e.host) });
  await browser.close(); await db.end();
  const report = { run, base: BASE, ids: { A: idA, C: idC }, checks, pass: checks.filter((c) => c.ok).length, fail: checks.filter((c) => !c.ok).length };
  fs.writeFileSync(path.join(OUT, "e2e-report.json"), JSON.stringify(report, null, 2));
  console.log(`\nRESULTADO ${report.pass} PASS · ${report.fail} FAIL`); process.exit(report.fail ? 1 : 0);
})().catch(async (e) => { console.error("ABORT", e); try { fs.writeFileSync(path.join(OUT, "e2e-report.json"), JSON.stringify({ aborted: String(e.stack || e), checks }, null, 2)); } catch {} process.exit(1); });
