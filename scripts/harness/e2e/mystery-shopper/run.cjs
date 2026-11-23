/* E2E autenticado de Mystery Shopper 2.0 (arnés local, USD 0).
 * Panel real del Command Center → doble clic → UN trabajo en Storage → worker real (navegador nuevo, cuenta QA)
 * → evidencias e informe en Storage → el panel muestra el resultado y conserva el historial.
 * También: dos workers a la vez (solo uno corre), worker muerto y reemplazado, 390×844 y 412×915, secretos fuera
 * de los informes y ninguna salida a proveedores. */
const fs = require("fs"), path = require("path"), { spawn } = require("child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const E2E = process.env.E2E_HOME, REPO = process.env.REPO, OUT = process.env.E2E_OUT, BASE = "http://127.0.0.1:3300";
const USERS = JSON.parse(fs.readFileSync(path.join(REPO, "scripts/harness/e2e/infra/users.json"), "utf8"));
const ADMIN = USERS.find((u) => u.email === "intruso@local.test"), QA = USERS.find((u) => u.email === "pilot-owner@local.test");
const RUNS = path.join(E2E, "storage/videos/mystery-shopper/v2/runs");
const DISPATCH = path.join(E2E, "logs/dispatch.jsonl");
const results = []; const ok = (name, cond, detail = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` ${String(detail).slice(0, 300)}` : ""}`); };
const env = Object.fromEntries(fs.readFileSync(path.join(E2E, "secrets/podcast-worker.env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const workerEnv = (jobId) => ({ ...process.env, NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY, NODE_OPTIONS: "", MS_JOB_ID: jobId,
  MYSTERY_SHOPPER_QA_EMAIL: QA.email, MYSTERY_SHOPPER_QA_PASSWORD: QA.password, PLAYWRIGHT_MODULE: process.env.PLAYWRIGHT_MODULE, MS_OUT_DIR: path.join(OUT, "worker"), MS_WORKER_RUN_URL: "local" });
const worker = (jobId, extra = {}) => new Promise((res) => {
  const p = spawn("npx", ["tsx", "scripts/mystery-shopper/worker.ts"], { cwd: REPO, env: { ...workerEnv(jobId), ...extra }, detached: true });
  let log = ""; p.stdout.on("data", (d) => { log += d; }); p.stderr.on("data", (d) => { log += d; });
  p.on("exit", (code) => res({ code, log, pid: p.pid })); res.proc = p;
});
const spawnWorker = (jobId) => { const p = spawn("npx", ["tsx", "scripts/mystery-shopper/worker.ts"], { cwd: REPO, env: workerEnv(jobId), detached: true }); let log = ""; p.stdout.on("data", (d) => { log += d; }); p.stderr.on("data", (d) => { log += d; }); return { p, log: () => log, done: new Promise((r) => p.on("exit", (c) => r(c))) }; };
const jobsOnDisk = () => (fs.existsSync(RUNS) ? fs.readdirSync(RUNS).filter((n) => n.startsWith("ms-")) : []);
const dispatches = (id) => (fs.existsSync(DISPATCH) ? fs.readFileSync(DISPATCH, "utf8").split("\n").filter((l) => l.includes("mystery-shopper-run") && (!id || l.includes(id))).length : 0);
const readJson = (id, f) => { try { return JSON.parse(fs.readFileSync(path.join(RUNS, id, f), "utf8")); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.E2E_CHROME || undefined });
  const session = async (user, w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/login`); await p.getByLabel("Correo electrónico").fill(user.email); await p.getByLabel("Contraseña").fill(user.password);
    await p.getByRole("button", { name: "Iniciar sesión" }).click(); await p.waitForURL(/\/dashboard/, { timeout: 60000 });
    return { ctx, p };
  };
  const panel = async (p) => { await p.goto(`${BASE}/dashboard/command-center#mystery-shopper`, { timeout: 120000 }); await p.getByTestId("ms-probar").waitFor({ timeout: 120000 }); };
  const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const pick = async (p, missionId, profile) => {
    await p.locator("#mystery-shopper details").first().evaluate((d) => { d.open = true; });
    await p.locator("#ms-mission").selectOption(missionId); if (profile) await p.locator("#ms-profile").selectOption(profile);
  };
  const startAndGetId = async (p, double) => {
    const before = new Set(jobsOnDisk());
    const btn = p.getByTestId("ms-probar");
    if (double) { await btn.evaluate((b) => { b.click(); b.click(); }); await btn.dblclick({ timeout: 2000 }).catch(() => {}); } else await btn.click();
    await p.getByTestId("ms-actual").waitFor({ timeout: 60000 });
    await sleep(2500);
    const fresh = jobsOnDisk().filter((n) => !before.has(n));
    return fresh;
  };

  // 1) Panel en 412×915 (S26 Ultra): simple, sin desbordamiento, doble clic → un trabajo y un despacho.
  const A = await session(ADMIN, 412, 915);
  await panel(A.p);
  await A.p.screenshot({ path: path.join(OUT, "01-panel-412.png"), fullPage: true });
  ok("panel 412×915: botón «PROBAR MI PLATAFORMA» y resumen visibles", await A.p.getByTestId("ms-probar").isVisible() && /Presupuesto autorizado\s*USD 0/.test(await A.p.getByTestId("ms-resumen").innerText()));
  ok("panel 412×915: sin desbordamiento horizontal", (await overflow(A.p)) <= 1, `${await overflow(A.p)}px`);
  const d0 = dispatches();
  const made1 = await startAndGetId(A.p, true);
  ok("doble clic en «PROBAR MI PLATAFORMA» → UN trabajo persistente", made1.length === 1, JSON.stringify(made1));
  const job1 = made1[0];
  ok("doble clic → UN despacho del worker", dispatches() - d0 === 1 && dispatches(job1) === 1, `${dispatches() - d0}`);
  ok("el trabajo guarda misión, perfil, destino y SHA pedido (no un recorrido grabado)", (() => { const j = readJson(job1, "job.json"); return j && j.missionId === "cuenta-navegacion" && j.target.kind === "local" && j.requestedSha && !fs.existsSync(path.join(RUNS, job1, "report.json")); })());
  ok("estado inicial: en cola, sin informe", /En cola/.test(await A.p.getByTestId("ms-estado").innerText()));

  // 2) Worker real para el trabajo 1 (cuenta y navegación, perfil impaciente por defecto del panel = principiante).
  const w1 = await worker(job1);
  fs.writeFileSync(path.join(OUT, "worker-1.log"), w1.log);
  const r1 = readJson(job1, "report.json"), s1 = readJson(job1, "status.json");
  ok("worker 1: termina y guarda el informe en Storage", w1.code === 0 && !!r1 && s1?.state === "terminada", `code=${w1.code} state=${s1?.state}`);
  ok("worker 1: navegador NUEVO (contexto sin cookies) con id de sesión y versión", r1?.browser?.freshContext === true && /^[0-9a-f-]{36}$/.test(r1?.browser?.sessionId ?? "") && !!r1?.browser?.version, JSON.stringify(r1?.browser));
  ok("worker 1: sesión autenticada real con la cuenta QA", r1?.authenticated === true && r1.steps.some((s) => /Iniciar sesión/.test(s.name) && s.state === "PASS"));
  ok("worker 1: cierre de sesión y vuelta a entrar", r1?.steps.some((s) => /Cerrar sesión/.test(s.name) && s.state === "PASS") && r1?.steps.some((s) => /Volver a entrar/.test(s.name) && s.state === "PASS"), JSON.stringify(r1?.steps.map((s) => `${s.name}:${s.state}`)));
  const ev1 = fs.existsSync(path.join(RUNS, job1, "evidence")) ? fs.readdirSync(path.join(RUNS, job1, "evidence")) : [];
  ok("worker 1: capturas por paso y registro de acciones en Storage", ev1.filter((n) => n.endsWith(".png")).length >= 3 && ev1.includes("actions.log"), ev1.join(","));
  const allText = [JSON.stringify(r1), ...ev1.filter((n) => n.endsWith(".log")).map((n) => fs.readFileSync(path.join(RUNS, job1, "evidence", n), "utf8")), w1.log].join("\n");
  ok("secretos: ni la contraseña QA ni la clave de servicio aparecen en informe, registro o salida", !allText.includes(QA.password) && !allText.includes(env.SUPABASE_SERVICE_ROLE_KEY) && !allText.includes(QA.email));
  ok("informe: misión con criterios comprobados y veredicto honesto", r1?.verdict && ["EVALUADO", "PARCIAL", "NO_EVALUADO"].includes(r1.verdict.coverage) && (r1.verdict.coverage === "EVALUADO" || r1.verdict.score === null), JSON.stringify(r1?.verdict));
  ok("informe: gasto USD 0 y alcance «atomivid-real»", r1?.spendUsd === 0 && r1?.scope === "atomivid-real");
  ok("informe: hechos, interpretación y recomendación separados", (r1?.findings ?? []).every((f) => f.fact && f.interpretation && f.recommendation));

  // 3) El panel muestra el resultado (sondeo) y lo explica en palabras sencillas.
  await A.p.getByTestId("ms-estado").filter({ hasText: /Terminada/ }).waitFor({ timeout: 30000 }).catch(() => {});
  await A.p.getByRole("button", { name: "Ver resultado" }).click({ timeout: 15000 }).catch(() => {});
  await A.p.getByTestId("ms-informe").waitFor({ timeout: 20000 }).catch(() => {});
  const inf = await A.p.getByTestId("ms-informe").innerText().catch(() => "");
  await A.p.screenshot({ path: path.join(OUT, "02-resultado-412.png"), fullPage: true });
  ok("panel: muestra el resultado del worker en palabras sencillas", /Resultado:/.test(inf) && /Qué encontró/.test(inf), inf.slice(0, 200));

  // 4) 390×844 (perfil impaciente): Audio Podcast con proyecto de prueba; dos workers a la vez → solo uno corre.
  const B = await session(ADMIN, 390, 844);
  await panel(B.p);
  ok("panel 390×844: sin desbordamiento horizontal", (await overflow(B.p)) <= 1, `${await overflow(B.p)}px`);
  await pick(B.p, "audio-proyecto-prueba", "impaciente");
  const made2 = await startAndGetId(B.p, false);
  const job2 = made2[0];
  ok("segundo trabajo creado (otra evaluación, otro id)", made2.length === 1 && job2 !== job1);
  const [x, y] = [spawnWorker(job2), spawnWorker(job2)];
  const [cx, cy] = await Promise.all([x.done, y.done]);
  const logs2 = x.log() + "\n" + y.log();
  fs.writeFileSync(path.join(OUT, "worker-2-concurrentes.log"), logs2);
  const claims2 = fs.readdirSync(path.join(RUNS, job2)).filter((n) => /^claim-\d+\.json$/.test(n));
  ok("dos workers simultáneos → solo uno ejecuta (el otro sale sin tocar nada)", claims2.length === 1 && /no se ejecuta \(en_curso\)/.test(logs2) && cx === 0 && cy === 0, `claims=${claims2} codes=${cx},${cy}`);
  const r2 = readJson(job2, "report.json");
  ok("audio: proyecto de prueba creado, guardado y recuperado tras recargar", r2?.steps.some((s) => /Recargar/.test(s.name) && s.state === "PASS") && r2?.steps.some((s) => /biblioteca/.test(s.name) && s.state === "PASS"), JSON.stringify(r2?.steps.map((s) => `${s.name}:${s.state}`)));
  ok("audio: el perfil impaciente hizo doble clic en «Crear episodio» y quedó un solo proyecto", (() => { const d = path.join(E2E, "storage/videos/audio-studio/v1", QA.id); return fs.existsSync(d) && fs.readdirSync(d).filter((n) => n.endsWith(".json")).length === 1; })());
  ok("audio: sesiones de navegador distintas entre evaluaciones", r2?.browser?.sessionId && r2.browser.sessionId !== r1?.browser?.sessionId);
  ok("audio: viewport 390×844 del perfil impaciente", r2?.browser?.viewport?.width === 390 && r2?.browser?.viewport?.height === 844);

  // 5) Worker muerto a mitad → otro toma el intento 2 y termina; el primero ya no puede escribir.
  await pick(B.p, "biblioteca-recuperar", "principiante");
  const job3 = (await startAndGetId(B.p, false))[0];
  const z = spawnWorker(job3);
  for (let i = 0; i < 120 && readJson(job3, "status.json")?.state !== "en_proceso"; i++) await sleep(500);
  process.kill(-z.p.pid, "SIGKILL"); await z.done.catch(() => {});
  const st = readJson(job3, "status.json");
  ok("worker 3 matado a mitad: el trabajo queda en proceso sin informe", st?.state === "en_proceso" && !fs.existsSync(path.join(RUNS, job3, "report.json")), st?.state);
  const early = await worker(job3);
  ok("con el latido reciente, otro worker NO lo pisa", /en_curso/.test(early.log) && fs.readdirSync(path.join(RUNS, job3)).filter((n) => /^claim-/.test(n)).length === 1);
  fs.writeFileSync(path.join(RUNS, job3, "status.json"), JSON.stringify({ ...st, heartbeatAt: new Date(Date.now() - 11 * 60000).toISOString(), updatedAt: new Date(Date.now() - 11 * 60000).toISOString() }));
  const takeover = await worker(job3);
  fs.writeFileSync(path.join(OUT, "worker-3-reemplazo.log"), takeover.log);
  const s3 = readJson(job3, "status.json");
  ok("sin latido (>10 min) otro worker toma el intento 2 y termina", takeover.code === 0 && s3?.attempt === 2 && s3?.state === "terminada" && !!readJson(job3, "report.json"), `attempt=${s3?.attempt} state=${s3?.state}`);

  // 6) Historial persistente: otra sesión (navegador nuevo) ve las 3 evaluaciones.
  const C = await session(ADMIN, 412, 915);
  await panel(C.p);
  await C.p.getByTestId("ms-historial").waitFor({ timeout: 30000 }).catch(() => {});
  const hist = await C.p.getByTestId("ms-historial").locator("li").count().catch(() => 0);
  await C.p.screenshot({ path: path.join(OUT, "03-historial-412.png"), fullPage: true });
  ok("historial persistente: otra sesión ve las 3 evaluaciones", hist >= 3, `${hist}`);
  const prod = await C.p.getByTestId("ms-productos").innerText();
  ok("estado por producto: muestra la última evaluación real y «Aún sin evaluación real» en el resto", /Cuenta y navegación\s*\n?.*(Funciona|No evaluado|Bloqueado)/.test(prod) && /Aún sin evaluación real/.test(prod), prod.slice(0, 300));
  // Repetir crea otra evaluación (no reutiliza el informe anterior).
  const beforeRepeat = jobsOnDisk().length;
  await C.p.getByTestId("ms-historial").getByRole("button", { name: "Repetir" }).first().click();
  await sleep(3000);
  ok("«Repetir» crea una evaluación nueva", jobsOnDisk().length === beforeRepeat + 1);

  // 7) Nada salió hacia proveedores de pago.
  const egress = fs.existsSync(path.join(E2E, "logs/egress.jsonl")) ? fs.readFileSync(path.join(E2E, "logs/egress.jsonl"), "utf8") : "";
  ok("sin salida a proveedores de pago (USD 0)", !/elevenlabs|heygen|openai|anthropic|recraft|fal\.ai|stripe/i.test(egress));

  await browser.close();
  console.log(`RESULTADO ${results.filter(Boolean).length}/${results.length} PASS`);
  fs.writeFileSync(path.join(OUT, "jobs.json"), JSON.stringify({ job1, job2, job3 }));
  process.exit(0);
})().catch((e) => { console.error(e); console.log(`RESULTADO ${results.filter(Boolean).length}/${results.length + 1} PASS`); process.exit(1); });
