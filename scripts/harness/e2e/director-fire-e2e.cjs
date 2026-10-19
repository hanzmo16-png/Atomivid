/**
 * F3 «prueba de fuego del Director» (T-20261019-1602, Grok). Next real + Playwright + worker + Remotion + FFmpeg + PG local,
 * mocks (Anthropic, OpenAI Images), egreso cerrado. Varias duraciones y formas de guion; cada MP4 pasa media_qa.py director
 * (criterios 1–10) y se reproduce y descarga desde la UI. Cualquier fallo ⇒ exit 1.
 *   E2E_OUT=<dir> E2E_DIR=<dir del arnés> node director-fire-e2e.cjs   (FIRE_CASES=short30,long60,… para un subconjunto)
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

async function waitTerminal(id, ms = 12 * 60000) { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await row(id); if (["completed", "failed"].includes(v.status)) return v; await sleep(3000); } return v; }
const dispatchesFor = (id) => jsonl(path.join(LOGS, "dispatches.jsonl")).filter((d) => d.payload?.requestId === id || (d.tag ?? "").startsWith(id));
function ffprobe(f) { return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", f]).toString()); }
const setWorkerOverride = (o) => fs.writeFileSync(path.join(LOGS, "worker-env-override.json"), JSON.stringify(o));
const OPENAI_LOG = () => jsonl(path.join(LOGS, "openai.jsonl"));
const WORKER_IMG = { WORKER_SCRIPT: process.env.E2E_IMAGES_WORKER ?? "scripts/harness/e2e/worker-images.ts", IMAGE_PROVIDER: "openai", OPENAI_API_KEY: "local-fake-openai", INTERNAL_PRODUCTION_OWNER_USER_ID: OWNER.id, ATOMIVID_WORKER_LOCAL_FIXTURE: "",
 };
// Material faltante: el guion [imgx] del mock trae escenas de DOS oraciones sobre un tema sin recurso propio; el 2.º plano
// no puede repetir el recurso del 1.º ⇒ el Director pide material nuevo (ai_image). Sin hooks en el código de producto.
// Ledger real (pi_paid_operations) de una solicitud; sin catch: un error de consulta aborta el E2E (exit 1).
const paidOps = async (id) => (await db.query("select idempotency_key, provider, shot_id, method, attempt_kind, status, reserved_usd::text r, committed_usd::text c, provider_job_id, updated_at::text u from public.pi_paid_operations where project_id=$1 order by created_at, idempotency_key", [id])).rows;
const APPROVED_USD = 2, IMAGE_UNIT_USD_MAX = 0.07; // tope aprobado en la UI; costo unitario del plan (director.json input.budget.unitCostsUsd.ai_image)
async function confirmWithMaterial(p, usd) {
  const inp = p.locator("#director-material-usd"); await inp.waitFor({ timeout: 30000 }); await inp.fill(String(usd));
  const [resp] = await Promise.all([p.waitForResponse((r) => /\/render$/.test(r.url()) && r.request().method() === "POST"), p.getByRole("button", { name: "Generar video final" }).click()]);
  return { status: resp.status(), body: (await resp.text()).slice(0, 400) };
}
let browser;
const CASES = [
  { id: "short30", tag: "[short]", dur: 30, label: "frases cortas", usd: 0 },
  { id: "long60", tag: "[long]", dur: 60, label: "párrafos largos", usd: 0 },
  { id: "uneven90", tag: "[uneven]", dur: 90, label: "escenas desiguales", usd: 0 },
  { id: "imgx30", tag: "[imgx]", dur: 30, label: "material insuficiente → relleno IA con tope aprobado", usd: 2 },
].filter((c) => !process.env.FIRE_CASES || process.env.FIRE_CASES.split(",").includes(c.id));
async function createReelD(p, topic, tag, dur) {
  await p.goto(`${BASE}/dashboard/new`); await skipTour(p);
  await p.getByText("Reel / Short").click();
  await p.fill("#topic", topic); await p.selectOption("#language", "es").catch(() => {});
  await p.selectOption("#style", { label: "Curiosidades" }); await p.getByText(`${dur}s`, { exact: true }).click();
  await p.getByRole("button", { name: "Crear solicitud" }).click(); await p.waitForURL(/created=1/);
  const r = (await db.query("select * from public.video_requests where user_id=$1 and topic=$2", [OWNER.id, topic])).rows;
  check(`[${tag}] formulario crea 1 solicitud de ${dur}s`, r.length === 1 && r[0].duration_seconds === dur, r.map((x) => x.duration_seconds));
  const id = r[0].id; await skipTour(p);
  await p.getByRole("button", { name: "Generar guion" }).first().click(); await p.waitForURL(new RegExp(`/dashboard/review/${id}`));
  await p.getByRole("button", { name: "Generar video final" }).waitFor(); await shot(p, `${tag}-revision`);
  return id;
}
const summary = [];
(async () => {
  db = new Client({ connectionString: process.env.HARNESS_PG_URL }); await db.connect();
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  const run = Date.now(); const S = await session(OWNER, "F3-fire"); setWorkerOverride(WORKER_IMG);
  for (const c of CASES) {
    const id = await createReelD(S.p, `F3 fuego ${c.label} ${c.tag} ${run}`, c.id, c.dur);
    const calls0 = OPENAI_LOG().length; const cf = await confirmWithMaterial(S.p, c.usd);
    const v = await waitTerminal(id, 20 * 60000); const calls = OPENAI_LOG().length - calls0; const ops = await paidOps(id);
    const ok = check(`[${c.id}] confirmación ${cf.status} y video completed`, cf.status < 300 && v.status === "completed", { cf, status: v.status, err: v.error_message });
    const ent = { case: c, id, status: v.status, err: v.error_message, imageCalls: calls, ledger: ops };
    if (c.usd === 0) check(`[${c.id}] tope 0 ⇒ 0 llamadas de imágenes y 0 operaciones openai`, calls === 0 && ops.every((o) => o.provider !== "openai"), { calls, ops });
    else check(`[${c.id}] relleno: llamadas = operaciones openai COMMITTED, cada una ≤ tope unitario y suma ≤ tope aprobado`, calls >= 1 && ops.filter((o) => o.provider === "openai" && o.status === "COMMITTED").length === calls && ops.filter((o) => o.provider === "openai").every((o) => Number(o.c) > 0 && Number(o.c) <= IMAGE_UNIT_USD_MAX) && ops.filter((o) => o.provider === "openai").reduce((a, o) => a + Number(o.c), 0) <= c.usd, { calls, ops });
    if (ok) {
      const dir = path.join(STORE, "videos", id, `attempt-${v.render_attempts}`); const mp4 = path.join(dir, "final.mp4"); const dj = path.join(dir, "director.json");
      const qaOut = path.join(OUT, `qa-${c.id}`);
      let qa; try { execFileSync("python3", [path.join(__dirname, "media_qa.py"), "director", mp4, dj, qaOut, String(c.dur)], { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { /* exit 1 ⇒ fallos registrados en el JSON */ }
      qa = JSON.parse(fs.readFileSync(path.join(qaOut, "media-qa-director.json"), "utf8"));
      for (const q of qa.checks) check(`[${c.id}] ${q.name}`, q.ok, q.detail);
      await S.p.goto(`${BASE}/dashboard/videos/${id}`); await skipTour(S.p);
      const video = S.p.locator("video").first(); await video.waitFor();
      await S.p.evaluate(() => { const x = document.querySelector("video"); x.muted = true; return x.play(); });
      const t0 = await video.evaluate((x) => x.currentTime); await sleep(3000);
      const st = await video.evaluate((x) => ({ t: x.currentTime, paused: x.paused, err: x.error && x.error.code, w: x.videoWidth, h: x.videoHeight, dur: x.duration }));
      await shot(S.p, `${c.id}-reproduccion`);
      check(`[${c.id}] reproducción en la UI avanza ≥ 2 s, 1080x1920, sin error`, st.t - t0 >= 2 && !st.err && st.w === 1080 && st.h === 1920, { t0, ...st });
      const [dl] = await Promise.all([S.p.waitForEvent("download"), S.p.getByRole("link", { name: /Descargar video/ }).click()]);
      const dlPath = path.join(OUT, `${c.id}-descarga.mp4`); await dl.saveAs(dlPath);
      check(`[${c.id}] descarga desde la UI = artefacto almacenado (sha256)`, sha(dlPath) === sha(mp4), { dl: sha(dlPath), stored: sha(mp4) });
      const d = JSON.parse(fs.readFileSync(dj, "utf8"));
      Object.assign(ent, { sha256: sha(mp4), qa: { pass: qa.pass, fail: qa.fail, loudness: qa.measurements.loudness }, scenes: d.props.scenes.length, captions: d.props.captions.length,
        motions: d.props.scenes.map((s) => s.direction?.motion), labels: d.props.scenes.map((s) => s.direction?.label), play: st });
    }
    summary.push(ent);
  }
  await closeSession(S);
  const eg = jsonl(path.join(LOGS, "egress.jsonl")).filter((e) => Date.parse(e.at) >= run); // intentos rechazados por next-intercept
  check(`Egreso: ningún intento hacia proveedores reales (openai/anthropic/elevenlabs/heygen) sin desviar; intentos bloqueados registrados: ${eg.length}`, !eg.some((e) => /openai|anthropic|elevenlabs|heygen/.test(e.host ?? "")), eg.slice(0, 10));
  fs.writeFileSync(path.join(OUT, "fire-summary.json"), JSON.stringify({ summary, checks }, null, 2));
  const fail = checks.filter((c) => !c.ok); console.log(`\nRESULTADO ${checks.length - fail.length} PASS · ${fail.length} FAIL`);
  await db.end(); await browser.close(); process.exit(fail.length ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
