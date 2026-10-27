/**
 * Recorrido de cierre YouTube Long Form (USD 0, solo 127.0.0.1, proveedores SIMULADOS):
 * formulario (UI) → guion del fixture inyectado por las RPC productivas (SIN LLM) → revisión de hechos/fuentes/continuidad
 * → configurar y confirmar (UI) → fallo de proveedor inyectado (Pexels 503) → «Reintentar» (UI) → worker real
 * (runRenderJob) → MP4 16:9 → reproducción y descarga en escritorio y Android (Pixel 7) → QC AV y libro de costos.
 * Cada comprobación es una aserción; «NO PROBADO» se declara aparte y nunca cuenta como PASS. Exit ≠ 0 si falla alguna.
 * Uso: E2E_HOME=… OUT=… node scripts/harness/e2e/longform-cierre/run.cjs
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"); const { execFileSync, spawnSync } = require("child_process");
const E = process.env.E2E_HOME, REPO = path.resolve(__dirname, "../../../.."), OUT = process.env.OUT || path.join(E, "out", "lf-cierre");
const { chromium, devices } = require(path.join(E, "deps/node_modules/playwright")); const { Client } = require(path.join(E, "deps/node_modules/pg"));
const PATHS = Object.fromEntries(fs.readFileSync(path.join(E, "paths.env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const PG_URL = `postgres://postgres@localhost:${PATHS.PGPORT}/atomivid?host=${E}/run`;
const BASE = "http://127.0.0.1:3100", FIXTURE = process.env.FIXTURE || path.join(__dirname, "fixture-panama.json");
const OWNER = require(path.join(REPO, "scripts/harness/e2e/infra/users.json"))[0];
const OTHER = require(path.join(REPO, "scripts/harness/e2e/infra/users.json"))[1];
const MOCK_LOG = path.join(E, "logs/mock-lf.jsonl"), FAULTS = path.join(E, "faults.json"), STORAGE = path.join(E, "storage/videos");
const WAIT_MIN = Number(process.env.LF_WAIT_MIN || 60);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const results = [], untested = [];
const log = (...a) => { const l = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); console.log(l); fs.appendFileSync(path.join(OUT, "journal.log"), `${new Date().toISOString()} ${l}\n`); };
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}`, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 400) : JSON.stringify(detail).slice(0, 400)); };
const notTested = (name, why) => { untested.push({ name, why }); log(`NO PROBADO ${name} — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const mockEvents = () => (fs.existsSync(MOCK_LOG) ? fs.readFileSync(MOCK_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const ffprobe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,duration:format=duration", "-of", "json", f]).toString());
const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const TOPIC = `${fx.topic} — cierre ${Date.now().toString(36)}`;

async function browserCtx(kind) {
  const b = await chromium.launch({ executablePath: PATHS.CHROME });
  const DEV = { android: "Pixel 7", samsung: "Galaxy S9+" };
  const opts = DEV[kind] ? { ...devices[DEV[kind]], acceptDownloads: true } : { viewport: { width: 1440, height: 900 }, acceptDownloads: true };
  const ctx = await b.newContext(opts); const p = await ctx.newPage(); p.setDefaultTimeout(120000);
  return { b, ctx, p };
}
async function login(p, email = OWNER.email, password = OWNER.password) {
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", email); await p.fill("input[name=password]", password);
  await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
}
const skipTour = (p) => p.getByRole("button", { name: "Omitir" }).click({ timeout: 4000 }).catch(() => {});
const overflow = (p) => p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `${n}.png`), fullPage: true }).catch(() => {});

/** Revisión del guion con el fixture verificable: hechos, fuentes, duplicaciones y continuidad. Sin red ni LLM. */
function reviewScript(script) {
  const beats = script.beats; const srcIds = new Set((script.sources || []).map((s) => s.id));
  check("guion: todos los bloques del fixture persistidos en orden", beats.length === fx.beats.length && beats.every((b, i) => b.narration === fx.beats[i].narration), `${beats.length}/${fx.beats.length}`);
  const sentences = beats.flatMap((b, i) => b.narration.split(/(?<=[.?!])\s+/).map((s) => ({ i, s: s.trim().toLowerCase() }))).filter((x) => x.s.split(/\s+/).length >= 5);
  const dup = sentences.filter((x, k) => sentences.findIndex((y) => y.s === x.s) !== k);
  check("guion: sin frases duplicadas entre bloques", dup.length === 0, dup.map((d) => d.s).slice(0, 3));
  const claims = beats.flatMap((b, i) => (b.claims || []).map((c) => ({ ...c, i })));
  check("hechos: cada hecho del fixture está como afirmación con fuentes en su bloque", fx.facts.every((f) => claims.some((c) => c.id === f.id && c.i === f.beat && c.support === "sourced")), claims.map((c) => `${c.id}@${c.i}`));
  check("hechos: el dato verificable aparece literalmente en la narración de su bloque", fx.facts.every((f) => beats[f.beat].narration.includes(f.token)), fx.facts.map((f) => f.token));
  check("fuentes: toda afirmación cita fuentes existentes del guion", claims.length > 0 && claims.every((c) => c.sourceIds.length > 0 && c.sourceIds.every((s) => srcIds.has(s))), [...srcIds]);
  const years = fx.facts.map((f) => (f.token.match(/\b1[89]\d\d\b/) || [])[0]).filter(Boolean).map(Number);
  check("continuidad: la cronología de los hechos avanza con el guion (sin saltos atrás)", years.every((y, k) => k === 0 || y >= years[k - 1]), years);
  check("continuidad: la resolución cierra la pregunta central en la segunda mitad", script.editorial?.reviews?.[0]?.ending?.evidence?.beatIndex >= Math.floor(beats.length / 2), script.editorial?.reviews?.[0]?.ending?.evidence);
}

(async () => {
  const c = new Client({ connectionString: PG_URL }); await c.connect();
  const q = async (sql, args = []) => (await c.query(sql, args)).rows;
  fs.writeFileSync(FAULTS, "{}");
  // ── A. Formulario (UI, escritorio) ─────────────────────────────────────────────────────────────────────────────
  let { b, p } = await browserCtx("desktop"); await login(p);
  await p.goto(`${BASE}/dashboard/long-form/new`); await skipTour(p);
  let o = await overflow(p); check("[escritorio] formulario Long Form sin scroll horizontal", o.sw <= o.iw + 1, o);
  await p.fill("input[name=topic]", TOPIC); await p.selectOption("select[name=language]", "es"); await p.fill("input[name=duration_minutes]", "3");
  await shot(p, "A01-formulario");
  await p.getByRole("button", { name: "Crear y revisar guion" }).click(); await p.waitForURL((u) => !String(u).includes("/long-form/new"));
  const job = (await q("select id,request_id,status from documentary_script_jobs where user_id=$1 and input->'fields'->>'topic'=$2 order by created_at desc limit 1", [OWNER.id, TOPIC]))[0];
  check("formulario: crea la solicitud y su trabajo de guion durable", !!job?.request_id, job);
  const R = job.request_id; const IDS = path.join(OUT, "ids.json"); fs.writeFileSync(IDS, JSON.stringify({ jobId: job.id, requestId: R }));
  // ── B. Guion simulado (sin LLM) por las RPC productivas ──────────────────────────────────────────────────────
  const inj = spawnSync("npx", ["tsx", path.join(__dirname, "inject.ts")], { cwd: REPO, encoding: "utf8", env: { ...process.env, FIXTURE, IDS_FILE: IDS, TOPIC, HARNESS_PG_URL: PG_URL, OUT_SCRIPT: path.join(OUT, "script-injected.json") } });
  log("inyección:", (inj.stdout + inj.stderr).trim().slice(0, 600));
  check("guion simulado aceptado por la puerta editorial productiva y guardado por finish_documentary_script_job", inj.status === 0, inj.status);
  const gateOut = JSON.parse(((inj.stdout || "").match(/DATED_GATE (\{.*\})/) || [])[1] || "{}");
  check("hechos fechados: la puerta productiva bloquea visuales sin anclar en pasajes con fecha y acepta los anclados a frases sin fecha", gateOut.unanchored > 0 && gateOut.anchored === 0, gateOut);
  const req0 = (await q("select status,script_json,duration_seconds,aspect_ratio from video_requests where id=$1", [R]))[0];
  log("solicitud tras guion:", { status: req0.status, duration: req0.duration_seconds, aspect: req0.aspect_ratio });
  reviewScript(req0.script_json);
  // ── C. Revisar y configurar (UI) ─────────────────────────────────────────────────────────────────────────────
  await p.goto(`${BASE}/dashboard/long-form/configure/${R}`); await skipTour(p);
  const main = () => p.locator("main").innerText();
  for (const t of ["Ver estructura narrativa", "Ver referencias recuperadas"]) await p.getByText(t).first().click().catch(() => log("sin desplegable", t));
  await p.getByText(/Revisar el guion \(/).first().click().catch(() => {});
  let txt = await main(); fs.writeFileSync(path.join(OUT, "C01-configurar.txt"), txt); await shot(p, "C01-configurar");
  check("revisión: la UI muestra la revisión editorial completada y la pregunta central", /Revisión editorial completada/.test(txt) && txt.includes(fx.storyPlan.centralQuestion), txt.slice(0, 200));
  check("revisión: la UI lista las fuentes del guion", fx.sources.every((s) => txt.includes(s.title)), fx.sources.map((s) => s.title));
  check("revisión: la UI muestra los bloques del guion completos", txt.includes(`Revisar el guion (${fx.beats.length} bloques)`) && fx.beats.every((bt) => txt.includes(bt.narration.slice(0, 40))));
  check("planificación visual: la UI muestra estrategia visual, plan de producción y comprobación previa", /Estrategia visual/.test(txt) && /Plan de producción/.test(txt) && /Comprobación previa/.test(txt));
  check("presupuesto: la UI indica que nada se genera ni cobra antes de confirmar", /Nada se genera ni se cobra hasta que confirmes/.test(txt));
  // Imágenes IA: el proveedor actual (OpenAI simulado). Recraft es área de Grok y no se ejerce en este recorrido.
  const cur = p.getByText("Proveedor actual (como hasta ahora)").first();
  if (await cur.count()) { await cur.click(); await sleep(800); txt = await main(); fs.writeFileSync(path.join(OUT, "C01b-proveedor-actual.txt"), txt); }
  check("material visual: sin impedimento de entrega para el guion anclado", !/IMPEDIMENTO DE ENTREGA/.test(txt) && !/No se puede iniciar todavía/.test(txt), (txt.match(/(IMPEDIMENTO[^\n]*|No se puede iniciar[^\n]*)/) || [""])[0]);
  check("planificación visual: plan sin Recraft (proveedor actual)", !/Imágenes originales \(Recraft\)\n[1-9]/.test(txt), (txt.match(/Escenas\n\d+/) || [""])[0]);
  const uiLimit = Number(((txt.match(/Límite autorizado por producción\s*USD\s*([0-9]+[.,][0-9]+)/) || [])[1] || "NaN").replace(",", "."));
  const usd = [...txt.matchAll(/USD\s?([0-9]+[.,][0-9]+)/g)].map((m) => Number(m[1].replace(",", ".")));
  log("importes en la pantalla de configuración:", usd);
  o = await overflow(p); check("[escritorio] configurar sin scroll horizontal", o.sw <= o.iw + 1, o);
  // Fallo de proveedor inyectado ANTES de confirmar: las búsquedas de Pexels devuelven 503 (suficientes para agotar los reintentos).
  fs.writeFileSync(FAULTS, JSON.stringify({ pexels: { mode: "503", remaining: Number(process.env.PEXELS_FAULTS || 400) } }));
  const tts0 = mockEvents().filter((e) => e.kind === "tts" && !e.fault).length;
  check("presupuesto: confirmar exige un límite autorizado visible", Number.isFinite(uiLimit) && uiLimit > 0, uiLimit);
  await p.getByRole("button", { name: "Confirmar y generar video" }).click(); await sleep(6000); await shot(p, "C02-confirmado");
  // killAt: etapa en la que se mata el worker (SIGKILL, como un runner perdido); el receptor ejecuta mark-render-failed como render.yml.
  const waitTerminal = async (tag, killAt) => {
    const t0 = Date.now(); let last = "", killed = false;
    for (;;) {
      const r = (await q("select status,render_attempts,long_form_stage,long_form_progress,video_path,error_message from video_requests where id=$1", [R]))[0];
      const s = JSON.stringify([r.status, r.long_form_stage, r.long_form_progress?.unitsCompleted]);
      if (s !== last) { log(tag, `${Math.round((Date.now() - t0) / 1000)}s`, r.status, r.long_form_stage || "", JSON.stringify(r.long_form_progress || {}).slice(0, 200)); last = s; }
      if (killAt && !killed && r.status === "processing" && r.long_form_stage === killAt) {
        const pids = spawnSync("pgrep", ["-f", "worker-longform.ts"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
        for (const pid of pids) spawnSync("kill", ["-9", pid]);
        killed = true; log(tag, `SIGKILL al worker en la etapa «${killAt}»`, pids);
      }
      if (["completed", "failed"].includes(r.status)) return { ...r, killed };
      if (Date.now() - t0 > WAIT_MIN * 60000) return { ...r, killed, timeout: true };
      await sleep(killAt && !killed ? 2000 : 10000);
    }
  };
  const count = (kind) => mockEvents().filter((e) => e.kind === kind && !e.fault).length;
  const ops = () => q("select idempotency_key,status,provider from pi_paid_operations where project_id=$1", [R]);
  const retry = async (n) => {
    await p.goto(`${BASE}/dashboard/videos/${R}`); await skipTour(p); await sleep(2000); const t = await main(); fs.writeFileSync(path.join(OUT, `D0${n}-antes-reintento.txt`), t); await shot(p, `D0${n}-antes-reintento`);
    const btn = p.getByRole("button", { name: "Reintentar" });
    check(`intento ${n}: la UI muestra el fallo y ofrece «Reintentar»`, (await btn.count()) > 0, t.slice(0, 300));
    await btn.first().click(); await sleep(6000);
  };
  // Intento 1 — fallo de proveedor de stock (503 en todas las búsquedas) ANTES de cualquier gasto.
  const r1 = await waitTerminal("intento-1");
  fs.writeFileSync(FAULTS, "{}");
  const ops1 = await ops();
  log("intento 1:", { status: r1.status, error: (r1.error_message || "").slice(0, 300), tts: count("tts") - tts0, pexelsFaults: mockEvents().filter((e) => e.kind === "pexels_fault").length });
  check("error de proveedor (Pexels 503): fallo explícito con mensaje, sin falso «listo»", r1.status === "failed" && !!r1.error_message && !r1.video_path, (r1.error_message || "").slice(0, 200));
  check("error de proveedor: se detiene ANTES de pagar (0 operaciones en el libro, 0 síntesis)", ops1.length === 0 && count("tts") === tts0, { ops: ops1.length, tts: count("tts") - tts0 });
  // Intento 2 — «Reintentar»; el worker muere durante el render (todo lo pagable ya pagado).
  await retry(2);
  const r2 = await waitTerminal("intento-2", "rendering");
  const ops2 = await ops(); const tts2 = count("tts"), img2 = count("openai_image");
  check("interrupción: el worker matado durante el render deja el pedido en fallo recuperable (sin video, sin «listo»)", r2.killed && r2.status === "failed" && !r2.video_path, { killed: r2.killed, status: r2.status, err: (r2.error_message || "").slice(0, 160) });
  check("interrupción: lo pagado antes del corte queda liquidado (sin reservas abiertas ni inciertas)", ops2.length > 0 && ops2.every((x) => x.status === "COMMITTED"), [...new Set(ops2.map((x) => x.status))]);
  // Intento 3 — «Reintentar» tras la interrupción: debe terminar sin volver a pagar nada.
  await retry(3);
  const final = await waitTerminal("intento-3");
  const ops3 = await ops();
  check("recuperación: el reintento no repite la voz (0 síntesis nuevas)", count("tts") === tts2, { intento2: tts2 - tts0, intento3: count("tts") - tts2 });
  check("recuperación: el reintento no regenera imágenes IA (0 generaciones nuevas)", count("openai_image") === img2, { intento2: img2, intento3: count("openai_image") - img2 });
  check("recuperación: el libro no gana operaciones ni claves duplicadas en el reintento", ops3.length === ops2.length && new Set(ops3.map((x) => x.idempotency_key)).size === ops3.length, { tras2: ops2.length, tras3: ops3.length });
  check("producción: el pedido termina «completed» con video", final.status === "completed" && !!final.video_path, { status: final.status, timeout: !!final.timeout, err: (final.error_message || "").slice(0, 200) });
  if (final.status !== "completed") { await finish(c, b, 1); return; }
  // ── D. Plan visual ↔ guion, escenas y activos ────────────────────────────────────────────────────────────────
  const row = (await q("select * from video_requests where id=$1", [R]))[0];
  fs.writeFileSync(path.join(OUT, "video_request.json"), JSON.stringify(row, null, 1));
  const plan = row.long_form_production_plan; const beatIds = row.script_json.beats.map((x) => x.id);
  const vr = JSON.parse(fs.readFileSync(path.join(STORAGE, R, "state/visual-report.json"), "utf8")); const scenes = vr.scenes || [];
  fs.writeFileSync(path.join(OUT, "visual-report.json"), JSON.stringify(vr, null, 1));
  const narr = Object.fromEntries(row.script_json.beats.map((x) => [x.id, x.narration.replace(/\s+/g, " ")]));
  check("storyboard: el plan confirmado reparte planos a TODOS los bloques del guion", beatIds.every((id) => (plan.beatShotCounts?.[id] ?? 0) > 0) && Object.values(plan.beatShotCounts).reduce((a2, n) => a2 + n, 0) === plan.shotCount, plan.beatShotCounts);
  check("plan visual: escenas ejecutadas = planos confirmados, cada una de un bloque del guion", scenes.length === plan.shotCount && scenes.every((x) => beatIds.includes(x.beatId)), { escenas: scenes.length, planos: plan.shotCount });
  check("plan visual ↔ guion: el fragmento narrado de cada escena pertenece a la narración de su bloque", scenes.every((x) => !x.narrationFragment || narr[x.beatId].includes(x.narrationFragment.replace(/\s+/g, " ").trim())), scenes.filter((x) => x.narrationFragment && !narr[x.beatId].includes(x.narrationFragment.trim())).map((x) => x.shotId).slice(0, 5));
  const gaps = scenes.slice(1).map((x, i) => +(x.startSec - scenes[i].endSec).toFixed(3)).filter((g) => Math.abs(g) > 0.05);
  check("escenas: línea de tiempo continua, sin huecos ni solapes (> 50 ms)", gaps.length === 0, gaps.slice(0, 5));
  check("escenas: ninguna vacía o perdida (todas con tipo ejecutado y recurso)", scenes.every((x) => x.executedType && x.display && x.durationSec > 0), [...new Set(scenes.map((x) => `${x.executedType}/${x.display}`))]);
  const cards = scenes.filter((x) => /text|card|tarjeta/i.test(`${x.executedType} ${x.display}`)).length;
  check("escenas: tarjetas de texto ≤ 25 % (no se rellena con texto)", cards / scenes.length <= 0.25, { tarjetas: cards, escenas: scenes.length });
  const assetDir = path.join(STORAGE, R, "assets"); const assets = fs.existsSync(assetDir) ? fs.readdirSync(assetDir) : [];
  check("activos: cada escena no textual apunta a un archivo guardado (assetRef existente)", scenes.filter((x) => x.display !== "card").every((x) => x.assetRef && fs.existsSync(path.join(STORAGE, x.assetRef))), scenes.filter((x) => x.display !== "card" && !(x.assetRef && fs.existsSync(path.join(STORAGE, x.assetRef)))).map((x) => x.shotId).slice(0, 5));
  check("informe visual del worker: 0 huecos, 0 escenas inciertas, 0 activos repetidos", vr.summary && vr.summary.gaps.length === 0 && vr.summary.uncertainScenes.length === 0 && vr.summary.repeatedAssets.length === 0, vr.summary && { gaps: vr.summary.gaps.length, inciertas: vr.summary.uncertainScenes.length, repetidos: vr.summary.repeatedAssets.length, unicos: vr.summary.uniqueAssets });
  check("activos: cada escena no textual tiene su archivo guardado (imágenes/clips simulados)", assets.length === scenes.length - cards, { archivos: assets.length, escenas: scenes.length, tarjetas: cards });
  // ── E. Libro de costos ───────────────────────────────────────────────────────────────────────────────────────
  const ledger = await q("select provider,status,idempotency_key,reserved_usd,committed_usd from pi_paid_operations where project_id=$1", [R]);
  fs.writeFileSync(path.join(OUT, "ledger.json"), JSON.stringify(ledger, null, 1));
  check("libro: cada operación pagada una sola vez (claves únicas)", ledger.length > 0 && new Set(ledger.map((x) => x.idempotency_key)).size === ledger.length, ledger.length);
  check("libro: sin reservas abiertas ni inciertas al terminar", ledger.every((x) => ["COMMITTED", "RELEASED", "REFUNDED"].includes(x.status)), [...new Set(ledger.map((x) => x.status))]);
  const spent = ledger.reduce((s, x) => s + Number(x.committed_usd || 0), 0);
  const ttsOps = ledger.filter((x) => x.provider === "elevenlabs").length; const ttsCalls = mockEvents().filter((e) => e.kind === "tts" && !e.fault).length - tts0;
  check("libro: llamadas de voz al proveedor simulado = operaciones de voz del libro (sin TTS duplicado)", ttsCalls === ttsOps, { ttsCalls, ttsOps });
  const rb = JSON.parse(fs.readFileSync(path.join(STORAGE, R, "state/request-budget.json"), "utf8"));
  const pb = JSON.parse(fs.readFileSync(path.join(STORAGE, R, "state/production-budget.json"), "utf8"));
  fs.writeFileSync(path.join(OUT, "budgets.json"), JSON.stringify({ request: rb, production: pb, uiLimitUsd: uiLimit, planEstimateUsd: plan.estimatedProviderCostUsd }, null, 1));
  check("presupuesto: gasto del libro ≤ techo autorizado del pedido", spent <= rb.ceilingUsd + 1e-9, { spent: +spent.toFixed(4), techo: rb.ceilingUsd });
  check("presupuesto: generativo dentro de su asignación y del tope duro de producción", pb.used.generativeUsd <= pb.allocation.maxGenerativeUsd + 1e-9 && pb.used.spentUsd <= pb.hardCap.capUsd + 1e-9 && pb.deviations.length === 0, pb.used);
  check("presupuesto: el gasto real no supera la estimación mostrada al confirmar", spent <= plan.estimatedProviderCostUsd + 1e-9, { spent: +spent.toFixed(4), estimacion: plan.estimatedProviderCostUsd });
  if (Number.isFinite(uiLimit)) check("presupuesto: gasto ≤ «Límite autorizado por producción» mostrado en la UI", spent <= uiLimit, { spent: +spent.toFixed(4), limite: uiLimit });
  // ── F. Resultado: reproducción y descarga en escritorio y Android ────────────────────────────────────────────
  const files = {};
  for (const kind of ["desktop", "android", "samsung"]) {
    const ctx2 = kind === "desktop" ? { b, p } : await browserCtx(kind); if (kind !== "desktop") await login(ctx2.p);
    const pg2 = ctx2.p; const tag = { desktop: "escritorio", android: "Android Pixel 7", samsung: "Android Samsung Galaxy S9+" }[kind];
    await pg2.goto(`${BASE}/dashboard/videos/${R}`); await skipTour(pg2); await sleep(3000); await shot(pg2, `F-${kind}-resultado`);
    o = await overflow(pg2); check(`[${tag}] resultado sin scroll horizontal`, o.sw <= o.iw + 1, o);
    const v = pg2.locator("video").first();
    const st = await v.evaluate(async (e) => { e.muted = true; try { await e.play(); } catch (x) { return { err: String(x) }; } await new Promise((r) => setTimeout(r, 2500)); return { rs: e.readyState, t: e.currentTime, w: e.videoWidth, h: e.videoHeight, d: e.duration, err: e.error && e.error.code }; }).catch((x) => ({ err: String(x) }));
    check(`[${tag}] el reproductor reproduce el MP4 16:9 1920×1080`, st.rs >= 3 && st.t > 0.5 && st.w === 1920 && st.h === 1080 && !st.err, st);
    const dl = await Promise.all([pg2.waitForEvent("download", { timeout: 300000 }), pg2.getByText("Descargar video").first().click()]).then(([d]) => d).catch((x) => { log("descarga falló", String(x)); return null; });
    if (dl) { const f = path.join(OUT, `descargado-${kind}.mp4`); await dl.saveAs(f); files[kind] = f; }
    check(`[${tag}] descarga del MP4 desde la página`, !!files[kind] && fs.statSync(files[kind]).size > 100000, files[kind] ? fs.statSync(files[kind]).size : null);
    if (kind !== "desktop") await ctx2.b.close();
  }
  // Aislamiento: otra cuenta no ve el video.
  { const o3 = await browserCtx("desktop"); await login(o3.p, OTHER.email, OTHER.password); const res = await o3.p.goto(`${BASE}/dashboard/videos/${R}`);
    const body = await o3.p.locator("body").innerText(); check("aislamiento: otra cuenta no ve el video ajeno (404, sin enlace)", (res.status() === 404 || /no encontrad|not found/i.test(body)) && (await o3.p.locator("video").count()) === 0, res.status()); await o3.b.close(); }
  // ── G. Validación del MP4 ────────────────────────────────────────────────────────────────────────────────────
  const stored = path.join(STORAGE, final.video_path);
  if (files.desktop) {
    check("descarga = archivo guardado (sha256 idéntico) en escritorio, Pixel 7 y Samsung", fs.existsSync(stored) && ["desktop", "android", "samsung"].every((k) => files[k] && sha(files[k]) === sha(stored)), { stored: fs.existsSync(stored), sha256: fs.existsSync(stored) ? sha(stored) : null });
    const pr = ffprobe(files.desktop); const vs = pr.streams.find((s) => s.codec_type === "video"), as = pr.streams.find((s) => s.codec_type === "audio");
    check("MP4: H.264 1920×1080 (16:9) + AAC", vs?.codec_name === "h264" && vs.width === 1920 && vs.height === 1080 && as?.codec_name === "aac", { v: vs && `${vs.codec_name} ${vs.width}x${vs.height}`, a: as?.codec_name });
    const dur = Number(pr.format.duration); const narr = mockEvents().filter((e) => e.kind === "tts" && !e.fault).reduce((s, e) => s + (e.seconds || 0), 0);
    check("MP4: duración coherente con la narración (±15 %)", dur > 60 && Math.abs(dur - narr) / narr < 0.15, { mp4: dur, narracion: +narr.toFixed(1) });
    const manifest = { version: 1, expected: { width: 1920, height: 1080, durationSeconds: dur, durationTolerancePct: 2, videoCodec: "h264", audioCodec: "aac", requireAudio: true }, loudness: { integratedLufs: -16, toleranceLu: 2, truePeakDbtp: -1 } };
    const mf = path.join(OUT, "av-manifest.json"); fs.writeFileSync(mf, JSON.stringify(manifest));
    const qc = spawnSync("npx", ["tsx", "scripts/av-qc.ts", files.desktop, mf, "--out", OUT, "--name", "lf-cierre"], { cwd: REPO, encoding: "utf8" });
    const rep = fs.existsSync(path.join(OUT, "lf-cierre.av-qc.json")) ? JSON.parse(fs.readFileSync(path.join(OUT, "lf-cierre.av-qc.json"), "utf8")) : null;
    log("av-qc:", qc.status, (qc.stdout || "").slice(-600));
    check("QC AV (scripts/av-qc.ts): decodifica sin errores, sin negro/congelado/silencio fuera de tolerancia, −16 LUFS", qc.status === 0, rep ? { verdict: rep.verdict, failures: (rep.findings || rep.failures || []).filter?.((f) => f.severity === "fail" || f.level === "FAIL").slice(0, 5) } : qc.stderr.slice(-300));
  }
  if (files.desktop) {
    const cp = spawnSync("python3", [path.join(__dirname, "captions-probe.py"), files.desktop], { encoding: "utf8" });
    const cap = JSON.parse(cp.stdout || "{}"); fs.writeFileSync(path.join(OUT, "captions-probe.json"), JSON.stringify(cap));
    check("subtítulos quemados presentes en ≥ 80 % de los fotogramas muestreados (heurística de píxeles, sin OCR)", cap.ratio >= 0.8, cap);
  }
  const egress = fs.existsSync(path.join(E, "logs/egress.jsonl")) ? fs.readFileSync(path.join(E, "logs/egress.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const bad = egress.filter((e) => /elevenlabs|pexels|fal\.|openai|anthropic|recraft|heygen|supabase\.co|stripe|wikimedia/i.test(e.host || ""));
  check("sin salida a proveedores reales (las salidas no locales se rechazan y registran)", bad.length === 0, [...new Set(egress.map((e) => e.host))]);
  notTested("Director Cinematográfico (controles de Grok)", "área de Grok: el recorrido usa el plan estándar que muestra la pantalla; no se modifican ni se ejercen sus controles");
  notTested("investigación con LLM y fuentes recuperadas en vivo", "el guion es del fixture (sin LLM); la generación real requiere Anthropic y búsqueda de fuentes (pago)");
  await finish(c, b, 0);
})().catch((e) => { console.error(e); check("recorrido sin excepción", false, String(e).slice(0, 400)); summary(); process.exit(1); });

function summary() {
  const pass = results.filter((r) => r.ok).length, fail = results.length - pass;
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ pass, fail, untested, results }, null, 1));
  console.log(`RESULTADO ${pass} PASS / ${fail} FAIL / ${untested.length} NO PROBADO`); return fail;
}
async function finish(c, b, code) { await b.close().catch(() => {}); await c.end().catch(() => {}); const fail = summary(); process.exit(fail || code ? 1 : 0); }
