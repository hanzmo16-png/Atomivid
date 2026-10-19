/**
 * E2E de IMÁGENES EXTRA del Director (Paso 4, T-20261019-1553, Grok). Basado en reel-browser-e2e.cjs.
 * Worker: worker-images.ts (runRenderJob sin la guarda loopback de worker-cli, OpenAI Images → mock local). Ver cierre.
 * Next local + Playwright/Chromium headless + Postgres local vía PostgREST
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
(async () => {
  db = new Client({ connectionString: process.env.HARNESS_PG_URL }); await db.connect();
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  const run = Date.now(); const S = await session(OWNER, "D-images");
  // ───── D1. Tope insuficiente ⇒ DirectorMaterialBudgetError antes de cualquier llamada ─────
  setWorkerOverride(WORKER_IMG);
  const id1 = await createReel(S.p, `E2E imagenes tope agotado [imgx] ${run}`, "D1");
  const calls0 = OPENAI_LOG().length; const tiny = process.env.E2E_RED === "1" ? 2 : 0.01; // RED: tope holgado ⇒ las aserciones de D1 deben fallar
  const c1 = await confirmWithMaterial(S.p, tiny); fs.writeFileSync(path.join(OUT, "D1-confirm.json"), JSON.stringify(c1));
  const v1 = await waitTerminal(id1, 8 * 60000);
  await S.p.goto(`${BASE}/dashboard/review/${id1}`); await skipTour(S.p); await sleep(1500); await shot(S.p, "D1-04-tope-agotado");
  const calls1 = OPENAI_LOG().length - calls0;
  check("[D1] confirmación aceptada con tope de material aprobado", c1.status >= 200 && c1.status < 300, c1);
  check("[D1] tope insuficiente ⇒ failed con DIRECTOR_MATERIAL_BUDGET / mensaje de tope", v1.status === "failed" && /DIRECTOR_MATERIAL_BUDGET|tope aprobado/i.test(String(v1.error_message)), { status: v1.status, err: v1.error_message });
  check("[D1] 0 llamadas al proveedor de imágenes con el presupuesto agotado", calls1 === 0, { calls1 });
  const f1 = fs.existsSync(path.join(STORE, "videos", id1)) ? execFileSync("find", [path.join(STORE, "videos", id1), "-type", "f"]).toString().split("\n").filter((f) => /director-fill|final\.mp4/.test(f)) : [];
  check("[D1] sin imágenes de relleno ni MP4 almacenados", f1.length === 0, f1);
  const ops1 = await paidOps(id1);
  check("[D1] ledger: 0 operaciones openai y exactamente 1 de guion (anthropic COMMITTED)", ops1.filter((o) => o.provider === "openai").length === 0 && ops1.filter((o) => o.provider === "anthropic").length === 1 && ops1.find((o) => o.provider === "anthropic")?.status === "COMMITTED", ops1);

  // ───── D2. Tope suficiente, intento 1 falla DESPUÉS del relleno (render roto a propósito) ─────
  const id2 = await createReel(S.p, `E2E imagenes extra [imgx] ${run}`, "D2");
  setWorkerOverride({ ...WORKER_IMG, REMOTION_BROWSER_EXECUTABLE: "/nonexistent/chrome-roto-a-proposito" });
  const callsA = OPENAI_LOG().length; const c2 = await confirmWithMaterial(S.p, 2);
  const v2a = await waitTerminal(id2, 10 * 60000); const gen1 = OPENAI_LOG().slice(callsA);
  const fills = () => { const d = path.join(STORE, "videos", id2); return fs.existsSync(d) ? execFileSync("find", [d, "-type", "f", "-name", "director-fill-*"]).toString().trim().split("\n").filter(Boolean) : []; };
  const fillsA = fills().map((f) => ({ f: path.relative(STORE, f), sha: sha(f) }));
  await S.p.goto(`${BASE}/dashboard/review/${id2}`); await skipTour(S.p); await sleep(1500); await shot(S.p, "D2-04-intento1-fallido");
  check("[D2] intento 1: relleno generado vía mock (≥1 llamada) y fallo posterior en el render", c2.status < 300 && v2a.status === "failed" && gen1.length >= 1 && v2a.render_attempts === 1, { c2, status: v2a.status, err: v2a.error_message, calls: gen1.length });
  check("[D2] cada imagen generada quedó almacenada (sha del PNG servido = objeto guardado)", gen1.length >= 1 && fillsA.length === gen1.length && gen1.every((g) => fillsA.some((o) => o.sha === g.sha256)), { gen1: gen1.map((g) => g.sha256), fillsA });

  const opsA = (await paidOps(id2)).filter((o) => o.provider === "openai");
  const fillKeys = fillsA.map((x) => "image:" + path.basename(x.f).replace(/\.png$/, "")).sort();
  check("[D2] ledger: exactamente 1 operación openai por imagen generada, una por plano (shot_id = clave de contenido del objeto)", opsA.length === gen1.length && JSON.stringify(opsA.map((o) => o.shot_id).sort()) === JSON.stringify(fillKeys) && new Set(opsA.map((o) => o.idempotency_key)).size === opsA.length, { opsA, fillKeys });
  check("[D2] ledger: cada operación COMMITTED con job registrado, 0 < comprometido ≤ reservado ≤ costo unitario del plan, y Σreservado ≤ tope aprobado", opsA.length > 0 && opsA.every((o) => o.status === "COMMITTED" && o.provider_job_id && o.method === "generate_image" && Number(o.r) > 0 && Number(o.r) <= IMAGE_UNIT_USD_MAX && Number(o.c) > 0 && Number(o.c) <= Number(o.r)) && opsA.reduce((t, o) => t + Number(o.r), 0) <= APPROVED_USD, opsA);
  // ───── D3. Reintento ─────
  // D3a: el botón «Reintentar» del panel (lo que un usuario real pulsa). D3b: si D3a no termina, el mismo POST que hace
  // la pantalla de revisión con el tope aprobado (directorMaterialUsd), desde la sesión del dueño.
  setWorkerOverride(WORKER_IMG); const callsB = OPENAI_LOG().length;
  await S.p.goto(`${BASE}/dashboard`); await skipTour(S.p);
  const card = S.p.locator("li", { hasText: `E2E imagenes extra [imgx] ${run}` });
  const [r3] = await Promise.all([S.p.waitForResponse((r) => /\/render$/.test(r.url()) && r.request().method() === "POST"), card.getByRole("button", { name: "Reintentar" }).click()]);
  const c3 = { status: r3.status(), body: (await r3.text()).slice(0, 400) }; fs.writeFileSync(path.join(OUT, "D3a-retry-ui.json"), JSON.stringify(c3));
  let v2 = await waitTerminal(id2, 12 * 60000); await shot(S.p, "D3a-panel-tras-reintento");
  const d3a = { status: v2.status, attempts: v2.render_attempts, err: v2.error_message, newCalls: OPENAI_LOG().length - callsB };
  fs.writeFileSync(path.join(OUT, "D3a-result.json"), JSON.stringify(d3a, null, 2));
  check("[D3a] «Reintentar» del panel: intento 2 sin llamadas nuevas al proveedor", c3.status < 300 && v2.render_attempts === 2 && d3a.newCalls === 0, { c3, d3a });
  check("[D3a] «Reintentar» del panel conserva el tope aprobado y termina el video", v2.status === "completed", d3a);
  if (v2.status !== "completed") {
    const c3b = await S.p.evaluate(async (id) => { const r = await fetch(`/api/generate/${id}/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directorMaterialUsd: 2 }) }); return { s: r.status, b: (await r.text()).slice(0, 400) }; }, id2);
    fs.writeFileSync(path.join(OUT, "D3b-retry-api.json"), JSON.stringify(c3b));
    v2 = await waitTerminal(id2, 12 * 60000);
    check("[D3b] reintento con el tope re-aprobado aceptado (2xx)", c3b.s < 300, c3b);
  }
  setWorkerOverride({});
  const att = v2.render_attempts;
  const gen2 = OPENAI_LOG().slice(callsB); const fillsB = fills().map((f) => ({ f: path.relative(STORE, f), sha: sha(f) }));
  check("[D3] reintento: video completed con video_path de su propio intento", v2.status === "completed" && att >= 2 && v2.video_path === `${id2}/attempt-${att}/final.mp4`, { status: v2.status, att, vp: v2.video_path, err: v2.error_message });
  check("[D3] los reintentos NO regeneran: 0 llamadas nuevas y mismos objetos de relleno (mismo sha)", gen2.length === 0 && JSON.stringify(fillsB) === JSON.stringify(fillsA), { gen2: gen2.length, fillsA, fillsB });
  const dj = path.join(STORE, "videos", id2, `attempt-${att}`, "director.json"), mp4 = path.join(STORE, "videos", id2, `attempt-${att}`, "final.mp4");
  let d = null; try { d = JSON.parse(fs.readFileSync(dj, "utf8")); } catch {}
  check("[D3] director.json: ok=true, materialFill con planos rellenados y gasto 0 en el reintento", d?.ok === true && d.materialFill?.shots?.length === gen1.length && d.materialFill.spentUsd === 0, { ok: d?.ok, fill: d?.materialFill });
  const opsB = await paidOps(id2); const opsBi = opsB.filter((o) => o.provider === "openai");
  fs.writeFileSync(path.join(OUT, "D-ledger-openai.json"), JSON.stringify({ afterAttempt1: opsA, afterRetries: opsBi, all: opsB }, null, 2));
  check("[D3] ledger: los reintentos no crean reservas ni liquidaciones nuevas (filas openai idénticas, mismo updated_at y comprometido)", JSON.stringify(opsBi) === JSON.stringify(opsA), { opsA, opsBi });
  check("[D3] ledger: 1 sola operación de guion para la solicitud (los reintentos de render no regeneran el guion)", opsB.filter((o) => o.provider === "anthropic").length === 1, opsB.filter((o) => o.provider === "anthropic"));
  fs.writeFileSync(path.join(OUT, "D-report-input.json"), JSON.stringify({ id1, id2, gen1, fillsA, fillsB, mp4: path.relative(STORE, mp4), dj: path.relative(STORE, dj) }, null, 2));
  await S.p.goto(`${BASE}/dashboard/videos/${id2}`); await skipTour(S.p); await S.p.locator("video").first().waitFor(); await shot(S.p, "D3-05-video");
  await closeSession(S);
  const egress = jsonl(path.join(LOGS, "egress.jsonl")).filter((e) => Date.parse(e.at) >= run);
  check("Egreso: 0 salidas reales; ningún intento hacia api.openai.com/api.anthropic.com quedó sin desviar", !egress.some((e) => /openai|anthropic/.test(e.host ?? "")), egress);
  await browser.close(); await db.end();
  const report = { run, ids: { D1: id1, D2: id2 }, checks, pass: checks.filter((c) => c.ok).length, fail: checks.filter((c) => !c.ok).length };
  fs.writeFileSync(path.join(OUT, "e2e-report.json"), JSON.stringify(report, null, 2));
  console.log(`\nRESULTADO ${report.pass} PASS · ${report.fail} FAIL`); process.exit(report.fail ? 1 : 0);
})().catch(async (e) => { console.error("ABORT", e); try { fs.writeFileSync(path.join(OUT, "e2e-report.json"), JSON.stringify({ aborted: String(e.stack || e), checks }, null, 2)); } catch {} process.exit(1); });
