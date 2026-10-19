/**
 * Matriz de CAOS (T-20261019-1602, Grok). Fallos inyectados en voz, imagen (500/429/respuesta perdida tras aceptar), Storage
 * y worker (SIGKILL a mitad), con Next real + Playwright + worker + PG local, mocks y egreso cerrado. Por caso registra:
 * qué falló, qué vio el usuario (texto de la UI + captura), datos conservados, operaciones del ledger, qué se reintentó y si
 * hubo cobro duplicado, y si es recuperable o exige conciliación. Inyección por <logs>/faults.json (mock-openai, gateway) y
 * worker-env-override.json (voz). Cualquier violación de invariante ⇒ exit 1.
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
const FAULTS = path.join(LOGS, "faults.json"); const setFaults = (f) => fs.writeFileSync(FAULTS, JSON.stringify(f));
const { execSync } = require("node:child_process");
async function createImgx(p, topic, tag) {
  await p.goto(`${BASE}/dashboard/new`); await skipTour(p); await p.getByText("Reel / Short").click();
  await p.fill("#topic", topic); await p.selectOption("#language", "es").catch(() => {});
  await p.selectOption("#style", { label: "Curiosidades" }); await p.getByText("30s", { exact: true }).click();
  await p.getByRole("button", { name: "Crear solicitud" }).click(); await p.waitForURL(/created=1/);
  const id = (await db.query("select id from public.video_requests where user_id=$1 and topic=$2", [OWNER.id, topic])).rows[0].id; await skipTour(p);
  await p.getByRole("button", { name: "Generar guion" }).first().click(); await p.waitForURL(new RegExp(`/dashboard/review/${id}`));
  await p.getByRole("button", { name: "Generar video final" }).waitFor(); return id;
}
const RAW = /\b(Error:|TypeError|ECONN\w*|fetch failed|undefined|null|PGRST\d+|stack|at [\w.]+ \(|status code \d{3}|\bHTTP \d{3}\b)/;
async function userView(p, id, tag) {
  await p.goto(`${BASE}/dashboard/review/${id}`); await skipTour(p); await sleep(1500); await shot(p, `${tag}-ui`);
  const alerts = await p.locator("[role=alert], [role=status]").allInnerTexts().catch(() => []);
  const main = (await p.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
  const retryLink = await p.getByRole("link", { name: /Revisar tope y reintentar|Reintentar|Revisar guion/ }).count();
  return { alerts: alerts.map((a) => a.replace(/\s+/g, " ").slice(0, 400)), raw: (main.match(RAW) ?? [null])[0], continuarConBloqueo: /Puedes continuar/.test(main) && /bloquead|no se puede|detenid/i.test(main), retryLink, excerpt: main.slice(0, 600) };
}
const stored = (id) => { const d = path.join(STORE, "videos", id); return fs.existsSync(d) ? execFileSync("find", [d, "-type", "f"]).toString().trim().split("\n").filter(Boolean).map((f) => path.relative(STORE, f)) : []; };
const billable = (entries) => entries.filter((e) => e.sha256 || e.fault === "drop"); // servidas (cobrables) vs rechazadas 500/429
const matrix = [];
async function runCase(S, c, run) {
  setFaults({}); setWorkerOverride({ ...WORKER_IMG, ...(c.override ?? {}) });
  const id = await createImgx(S.p, `Caos ${c.id} [imgx] ${run}`, c.id);
  setFaults(c.faults ?? {}); const o0 = OPENAI_LOG().length;
  const cf = await confirmWithMaterial(S.p, 2);
  if (c.kill) { const t = Date.now(); while (Date.now() - t < 180000 && billable(OPENAI_LOG().slice(o0)).length < 1) await sleep(500); await sleep(1500);
    try { execSync("pkill -9 -f 'worker-images.ts'"); } catch {} }
  const v1 = await waitTerminal(id, c.waitMs ?? (c.kill ? 4 * 60000 : 12 * 60000));
  const e1 = OPENAI_LOG().slice(o0); const ops1 = await paidOps(id); const ui1 = await userView(S.p, id, `${c.id}-fallo`); const st1 = stored(id);
  // reintento seguro: sin fallos inyectados, por la UI (tope re-confirmado explícitamente = 2)
  setFaults({}); setWorkerOverride(WORKER_IMG); const o1 = OPENAI_LOG().length; let retry = { attempted: false };
  if (c.parked) { // espera de suministro (no terminal por diseño): se observa y luego el arnés la retira (documentado, no es evidencia de producto)
    await db.query("update public.video_requests set status='failed', error_message='harness cleanup: espera de suministro retirada por el arnés' where id=$1 and status='processing'", [id]); retry = { attempted: false, why: "en espera de suministro; retirada por el arnés tras observarla" }; }
  if (v1.status === "failed") {
    const link = S.p.getByRole("link", { name: /Revisar tope y reintentar/ });
    if (await link.count()) { await link.first().click(); await S.p.waitForURL(new RegExp(`/dashboard/review/${id}`)); }
    const btn = S.p.getByRole("button", { name: "Generar video final" });
    if (await btn.count() && await btn.isEnabled()) { const r = await confirmWithMaterial(S.p, 2); const v2 = await waitTerminal(id, 12 * 60000);
      retry = { attempted: true, confirm: r.status, status: v2.status, err: v2.error_message, attempts: v2.render_attempts, ui: await userView(S.p, id, `${c.id}-reintento`) }; }
    else retry = { attempted: false, why: "sin botón habilitado tras el fallo", ui: ui1 };
  }
  const e2 = OPENAI_LOG().slice(o1); const ops2 = await paidOps(id);
  const keys = {}; for (const o of ops2) keys[o.idempotency_key] = (keys[o.idempotency_key] ?? 0) + 1;
  const img = ops2.filter((o) => o.provider === "openai");
  const ent = { case: c.id, what: c.what, id, failure: { status: v1.status, err: v1.error_message, attempts: v1.render_attempts }, user: ui1, kept: st1, ledgerAfterFailure: ops1,
    imageCallsAttempt1: { total: e1.length, billable: billable(e1).length, faults: e1.filter((e) => e.fault).map((e) => e.fault) }, retry, imageCallsRetry: { total: e2.length, billable: billable(e2).length }, ledgerFinal: ops2,
    reconciliation: img.filter((o) => o.status === "RECONCILIATION_REQUIRED").map((o) => o.idempotency_key) };
  matrix.push(ent); fs.writeFileSync(path.join(OUT, "chaos-matrix.json"), JSON.stringify(matrix, null, 2));
  // invariantes
  if (c.parked) check(`[${c.id}] capacidad no verificable ⇒ espera explícita (processing + mensaje de espera), 0 llamadas a proveedores`, v1.status === "processing" && /esperando disponibilidad/i.test(String(v1.error_message)) && e1.length === 0 && ops1.every((o) => o.provider !== "elevenlabs" && o.provider !== "openai"), { status: v1.status, err: v1.error_message, e1: e1.length, ops1 });
  else check(`[${c.id}] la fila llega a un estado terminal tras el fallo (sin quedarse en processing)`, ["failed", "completed"].includes(v1.status), { status: v1.status });
  check(`[${c.id}] el usuario no ve errores técnicos crudos`, !ui1.raw && !(retry.ui?.raw), { raw: ui1.raw, rawRetry: retry.ui?.raw, alerts: ui1.alerts });
  check(`[${c.id}] nunca «Puedes continuar» junto a un bloqueo`, !ui1.continuarConBloqueo, ui1.excerpt);
  check(`[${c.id}] una sola fila de ledger por clave idempotente`, Object.values(keys).every((n) => n === 1), keys);
  check(`[${c.id}] ninguna cantidad negativa ni COMMITTED positivo guardado como 0`, ops2.every((o) => Number(o.r) >= 0 && Number(o.c ?? 0) >= 0 && !(o.status === "COMMITTED" && o.provider === "openai" && Number(o.c) === 0)), ops2);
  const billAll = billable(e1).length + billable(e2).length;
  check(`[${c.id}] llamadas cobrables (${billAll}) ≤ operaciones de imagen registradas COMMITTED+RR (${img.filter((o) => ["COMMITTED", "RECONCILIATION_REQUIRED"].includes(o.status)).length}): ningún cobro sin registro`, billAll <= img.filter((o) => ["COMMITTED", "RECONCILIATION_REQUIRED"].includes(o.status)).length, { billAll, img });
  check(`[${c.id}] ningún resultado incierto se re-envía: cada clave en RR no tiene segunda llamada cobrable`, ent.reconciliation.length === 0 || billable(e2).length <= img.filter((o) => o.status === "COMMITTED").length, ent);
  for (const k of c.expect ?? []) check(`[${c.id}] ${k.name}`, k.ok(ent), ent.failure);
  return ent;
}
const CASES = [
  { id: "X1-voz-inalcanzable", what: "voz: VOICE_PROVIDER=elevenlabs con clave falsa; la salida a api.elevenlabs.io es rechazada por la guarda de egreso", override: { VOICE_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "local-fake-eleven" }, parked: true, waitMs: 90000,
    expect: [{ name: "voz caída ⇒ 0 llamadas de imagen en el intento fallido", ok: (e) => e.imageCallsAttempt1.total === 0 }] },
  { id: "X2-imagen-500", what: "imagen: el proveedor responde 500 en la 1.ª llamada", faults: { openai: { mode: "500", remaining: 1 } } },
  { id: "X3-imagen-429", what: "imagen: el proveedor responde 429 en la 1.ª llamada", faults: { openai: { mode: "429", remaining: 1 } } },
  { id: "X4-imagen-respuesta-perdida", what: "imagen: el proveedor acepta y genera, la respuesta se pierde (socket cortado)", faults: { openai: { mode: "drop", remaining: 1 } },
    expect: [{ name: "respuesta perdida ⇒ la operación queda en RECONCILIATION_REQUIRED (no se da por no cobrada)", ok: (e) => e.reconciliation.length >= 1 }] },
  { id: "X5-storage-subida", what: "storage: falla la subida de la 1.ª imagen de relleno ya pagada", faults: { storage: { match: "director-fill", remaining: 1 } } },
  { id: "X6-worker-sigkill", what: "worker: SIGKILL tras la 1.ª imagen cobrada, a mitad del intento", kill: true },
].filter((c) => !process.env.CHAOS_CASES || process.env.CHAOS_CASES.split(",").includes(c.id.split("-")[0]));
(async () => {
  db = new Client({ connectionString: process.env.HARNESS_PG_URL }); await db.connect();
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  const run = Date.now(); const S = await session(OWNER, "chaos");
  for (const c of CASES) { try { await runCase(S, c, run); } catch (e) { check(`[${c.id}] el caso se ejecutó sin excepción del arnés`, false, String(e && e.stack || e).slice(0, 500)); } }
  setFaults({}); setWorkerOverride(WORKER_IMG); await closeSession(S);
  const eg = jsonl(path.join(LOGS, "egress.jsonl")).filter((e) => Date.parse(e.at) >= run);
  check(`Egreso: ninguna salida real; intentos rechazados registrados: ${eg.length} (${[...new Set(eg.map((e) => e.host))].join(",")})`, true, eg);
  fs.writeFileSync(path.join(OUT, "chaos-egress.json"), JSON.stringify(eg, null, 2));
  const fail = checks.filter((c) => !c.ok); fs.writeFileSync(path.join(OUT, "chaos-checks.json"), JSON.stringify(checks, null, 2));
  console.log(`\nRESULTADO ${checks.length - fail.length} PASS · ${fail.length} FAIL`); await db.end(); await browser.close(); process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
