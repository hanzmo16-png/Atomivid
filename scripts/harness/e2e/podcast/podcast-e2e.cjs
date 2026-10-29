// E2E Podcast 2.1 con UI real (Chromium, clics reales), rutas/handlers reales, PG+PostgREST reales, worker real.
// Solo ElevenLabs está simulado (mock-elevenlabs.mjs + espeak-ng). USD 0. Uso: node podcast-e2e.cjs <casos: 1,2,3,4,5,6>
const path = require("node:path"), fs = require("node:fs"), crypto = require("node:crypto"), { execFileSync, spawn } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE); const { Client } = require(process.env.HARNESS_PG_MODULE);
const BASE = "http://127.0.0.1:3300", E2E = process.env.E2E_HOME, OUT = process.env.E2E_OUT, REPO = process.env.REPO;
const ELLOG = path.join(E2E, "logs/elevenlabs.jsonl"), FAILF = path.join(E2E, "run/el-fail");
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const OTHER = { id: "22222222-2222-4222-8222-222222222222", email: "intruso@local.test", password: "local-pass-other-2" };
const DURO = "DuroPruebaLocal03", ANA = "VozCatalogoAna01", LEO = "VozCatalogoLeo02";
fs.mkdirSync(OUT, { recursive: true });
const results = []; const ok = (name, cond, detail = "") => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"} ${name} ${detail}`); };
const ttsCalls = () => fs.existsSync(ELLOG) ? fs.readFileSync(ELLOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let db, browser;
const ep = async (id) => (await db.query("select * from public.podcast_episodes where id=$1", [id])).rows[0];
async function session(user, tag, device = null) {
  const vp = device?.viewport ?? { width: 1280, height: 1000 };
  const ctx = await browser.newContext({ viewport: vp, ...(device ?? {}), recordVideo: { dir: path.join(OUT, `video-${tag}`), size: vp }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(60000);
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", user.email); await p.fill("input[name=password]", user.password);
  await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
  return { ctx, p };
}
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `${n}.png`), fullPage: true });
function markFailed(id, kind) {
  const env = { ...process.env, ...Object.fromEntries(fs.readFileSync(path.join(E2E, "secrets/podcast-worker.env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])), EPISODE_ID: id, JOB_KIND: kind, NPM_CONFIG_UPDATE_NOTIFIER: "false" };
  return new Promise((res) => { const w = spawn("npx", ["tsx", "scripts/podcast-video-mark-failed.ts"], { cwd: REPO, env }); let o = ""; w.stdout.on("data", (d) => (o += d)); w.stderr.on("data", (d) => (o += d)); w.on("close", (c) => res({ code: c, out: o })); });
}
function worker(id, kind, extra = {}) {
  const env = { ...process.env, ...extra, ...Object.fromEntries(fs.readFileSync(path.join(E2E, "secrets/podcast-worker.env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])), EPISODE_ID: id, JOB_KIND: kind, NPM_CONFIG_UPDATE_NOTIFIER: "false", ...extra };
  return new Promise((res) => { const w = spawn("npx", ["tsx", "scripts/podcast-video-worker.ts"], { cwd: REPO, env }); let o = ""; w.stdout.on("data", (d) => (o += d)); w.stderr.on("data", (d) => (o += d)); w.on("close", (c) => { fs.appendFileSync(path.join(OUT, `worker-${id}-${kind}.log`), o); res({ code: c, out: o, proc: w }); }); });
}
async function createEpisode(p, o) {
  await p.goto(`${BASE}/dashboard/podcast`);
  // Podcast 3.0: el formulario clásico vive dentro de «Formulario clásico» (el asistente es la vista principal).
  const classic = p.getByText("Formulario clásico (grabación propia, guion A/B)");
  if (await classic.count()) await classic.click();
  await p.getByLabel("Título", { exact: true }).fill(o.title);
  if (o.conversation) await p.getByLabel("Conversación (2 participantes)").check();
  if (o.emotional) await p.getByLabel("Emocional (director de voz)").check();
  if (o.music) await p.getByLabel(/Música de fondo/).check();
  await p.locator("textarea").fill(o.script);
  const voiceSel = p.locator("select:not([aria-label=\"Voz B\"])").filter({ has: p.locator(`option[value="${o.voiceA}"]`) }).first();
  await voiceSel.selectOption(o.voiceA);
  if (o.conversation) { await p.getByLabel("Nombre A").fill(o.nameA); await p.getByLabel("Nombre B").fill(o.nameB); await p.getByLabel("Rol B").fill("Curiosa, pregunta y discrepa"); await p.getByLabel("Voz B").selectOption(o.voiceB); }
  await shot(p, `${o.tag}-01-formulario`);
  await p.getByRole("button", { name: /Crear episodio/ }).click();
  await p.waitForURL(/\/dashboard\/podcast\/[0-9a-f-]{36}$/);
  return p.url().split("/").pop();
}
async function generate(p, id, tag) {
  const DLOG = path.join(E2E, "logs/dispatch.jsonl"), dlen = () => (fs.existsSync(DLOG) ? fs.statSync(DLOG).size : 0), d0 = dlen();
  // Espera la respuesta del POST antes de leer el estado: reanudar desde «failed» ya es terminal y, si el servidor
  // tarda en despachar (p. ej. al calcular lo pendiente), el bucle salía antes de ver el despacho (carrera, c4).
  const resp = p.waitForResponse((r) => r.request().method() === "POST" && /\/api\/podcast\/[^/]+\/generate$/.test(new URL(r.url()).pathname), { timeout: 60000 }).catch(() => null);
  await p.getByRole("button", { name: /Generar narración|Continuar \/ reintentar/ }).click();
  await resp;
  // Corto (≤6000 car.): narra dentro de la petición. Largo: despacha al worker (aquí, al registrador local) → se ejecuta el worker real.
  let row; for (let i = 0; i < 600; i++) { await p.waitForTimeout(500); row = await ep(id); if (row.status !== "generating" && row.status !== "draft") break; if (dlen() > d0) { await p.waitForTimeout(500); break; } }
  row = await ep(id);
  if (row.status !== "ready" && dlen() > d0) { const w = await worker(id, "narration"); ok(`${tag}: worker de narración termina`, w.code === 0, `exit ${w.code}`); }
  await p.reload(); await shot(p, `${tag}-02-listo`);
  return ep(id);
}
async function download(p, tag) {
  const [d] = await Promise.all([p.waitForEvent("download"), p.getByText("Descargar episodio (M4A)").click()]);
  const f = path.join(OUT, `${tag}.m4a`); await d.saveAs(f); return f;
}
function probe(f) { return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name", "-of", "json", f]).toString()); }
function loud(f) { const e = require("node:child_process").spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 }).stderr; const I = Number(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold[\s\S]*LRA:\s+([\d.]+)/.exec(e)?.[1]), LRA = Number(/LRA:\s+([\d.]+) LU\s*\n\s*Threshold[\s\S]*LRA low/.exec(e)?.[1]), TP = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(e.slice(e.lastIndexOf("True peak")))?.[1]); return { I, LRA, TP }; }
const fixtures = () => { require(path.join(REPO, "node_modules/tsx/dist/cjs/api/index.cjs")).register(); return require(path.join(REPO, "scripts/podcast-2-0/fixtures.ts")); };

(async () => {
  db = new Client({ connectionString: process.env.HARNESS_PG_URL }); await db.connect();
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROME, headless: true });
  const cases = (process.argv[2] ?? "1,2,3,4,5,6,7,8").split(",");
  const F = fixtures();
  const convScript = F.conversationFixture().turns.map((t) => `${t.speaker}: ${t.text}`).join("\n\n");
  const s = await session(OWNER, "owner");
  const summary = {};
  if (cases.includes("2")) {
    const before = ttsCalls().length;
    const id = await createEpisode(s.p, { tag: "c2", title: "E2E caso 2 diálogo A/B", conversation: true, emotional: true, music: true, script: convScript, voiceA: DURO, voiceB: ANA, nameA: "Hans", nameB: "Invitada" });
    const row = await generate(s.p, id, "c2");
    const calls = ttsCalls().slice(before), prod = row.production;
    ok("c2: episodio listo", row.status === "ready", row.error ?? "");
    const byVoice = calls.reduce((m, c) => ((m[c.voiceId] = (m[c.voiceId] ?? 0) + 1), m), {});
    const aTurns = prod.turns.filter((t) => t.speaker === "A").length, bTurns = prod.turns.length - aTurns;
    ok("c2: A solo con su voz, B solo con la suya", byVoice[DURO] === aTurns && byVoice[ANA] === bTurns && Object.keys(byVoice).length === 2, JSON.stringify(byVoice));
    ok("c2: línea de tiempo alterna hablantes y conserva IDs", row.production_timeline.map((t) => t.turn_id).join() === prod.turns.map((t) => t.id).join());
    ok("c2: emocional cambia ajustes por segmento (no global)", new Set(calls.map((c) => JSON.stringify(c.settings))).size > 2);
    const f = await download(s.p, "c2"); const l = loud(f), pr = probe(f);
    ok("c2: descarga = audio guardado (sha)", sha(fs.readFileSync(f)) === row.audio_sha256);
    ok("c2: loudness −16±1.5 LUFS, TP ≤ −1, LRA ≤ 15", Math.abs(l.I + 16) <= 1.5 && l.TP <= -1 && l.LRA <= 15, JSON.stringify(l));
    summary.c2 = { id, duration: Number(pr.format.duration), calls: calls.length, byVoice, loud: l, sha: row.audio_sha256 };
    // Caso 4 sobre el mismo episodio: refrescar, salir/volver, regenerar → 0 llamadas
    if (cases.includes("4")) {
      const n0 = ttsCalls().length;
      await s.p.reload(); await s.p.goto(`${BASE}/dashboard`); await s.p.goto(`${BASE}/dashboard/podcast/${id}`);
      await db.query("update podcast_episodes set status='failed', run_token=null where id=$1", [id]);
      const DLOG4 = path.join(E2E, "logs/dispatch.jsonl"), dispatches = () => (fs.existsSync(DLOG4) ? fs.readFileSync(DLOG4, "utf8").trim().split("\n").filter(Boolean) : []);
      const d4 = dispatches().length;
      await s.p.reload(); await generate(s.p, id, "c4-reanudar");
      ok("c4: reanudar despacha el worker real (sin nada pendiente que pagar)", dispatches().length > d4 && (await ep(id)).status === "ready", `despachos=${dispatches().length - d4}`);
      ok("c4: refresh/volver/reanudar no repite síntesis pagada", ttsCalls().length === n0, `${ttsCalls().length - n0} llamadas nuevas`);
      // matar el worker a mitad: episodio nuevo largo, se mata tras ~N llamadas, se reanuda
      const id2 = await createEpisode(s.p, { tag: "c4", title: "E2E caso 4 interrupción", conversation: true, script: convScript, voiceA: LEO, voiceB: ANA, nameA: "A", nameB: "B" });
      await s.p.getByRole("button", { name: /Generar narración/ }).click(); await s.p.waitForTimeout(1500);
      const m0 = ttsCalls().length;
      const envw = { ...process.env, ...Object.fromEntries(fs.readFileSync(path.join(E2E, "secrets/podcast-worker.env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])), EPISODE_ID: id2, JOB_KIND: "narration", NPM_CONFIG_UPDATE_NOTIFIER: "false" };
      const w = spawn("npx", ["tsx", "scripts/podcast-video-worker.ts"], { cwd: REPO, env: envw, detached: true });
      while (ttsCalls().length - m0 < 10) await new Promise((r) => setTimeout(r, 300));
      process.kill(-w.pid, "SIGKILL"); await new Promise((r) => setTimeout(r, 1500));
      const killedAt = ttsCalls().length - m0;
      await db.query("update podcast_episodes set run_started_at = now() - interval '1 hour' where id=$1", [id2]); // simula función muerta (stale)
      const r2 = await worker(id2, "narration"); const after = await ep(id2); const total = ttsCalls().length - m0; const turns = after.production.turns.length;
      // Diseño: la llamada que estaba en vuelo al matar el proceso es ambigua (pudo cobrarse). NO se reenvía; el episodio queda en revisión con mensaje claro.
      // Dos desenlaces válidos según dónde cae el SIGKILL: (a) entre llamadas → reanuda y termina con 1 llamada por turno exacta;
      // (b) con una llamada en vuelo → no la reenvía, queda «incierto» para revisión. Cualquier otro = doble cobro o pérdida.
      ok("c4: worker matado → reanudación sin cobro doble", (after.status === "ready" && total === turns) || (after.status === "failed" && total === killedAt && /incierto/i.test(after.error ?? "")), `llamadas=${total} matado tras ${killedAt} estado=${after.status} «${after.error}»`);
      const held = (await db.query("select status, count(*)::int n from pi_paid_operations where idempotency_key like 'op_%' and updated_at > now() - interval '10 minutes' group by 1")).rows;
      ok("c4: lo pagado antes del corte queda guardado (no se pierde)", held.some((r) => r.status === "COMMITTED"), JSON.stringify(held));
      summary.c4 = { id2, killedAt, total, turns };
    }
  }
  if (cases.includes("1")) {
    const before = ttsCalls().length;
    const script = F.narrationFixture().map((x) => x.text).join("\n\n");
    const id = await createEpisode(s.p, { tag: "c1", title: "E2E caso 1 narración individual", emotional: true, music: true, script, voiceA: DURO });
    const row = await generate(s.p, id, "c1");
    const calls = ttsCalls().slice(before);
    ok("c1: listo, voz El Duro (dueño)", row.status === "ready" && calls.every((c) => c.voiceId === DURO), `${calls.length} llamadas`);
    const speeds = calls.map((c) => c.settings?.speed ?? 1);
    ok("c1: ritmo varía solo en parte de los segmentos (sin ralentización global)", speeds.some((x) => x !== 1) && speeds.filter((x) => x === 1).length > speeds.length * 0.3, `${speeds.filter((x) => x !== 1).length}/${speeds.length} con speed≠1`);
    const f = await download(s.p, "c1"); const l = loud(f);
    ok("c1: descarga íntegra y loudness", sha(fs.readFileSync(f)) === row.audio_sha256 && Math.abs(l.I + 16) <= 1.5 && l.TP <= -1, JSON.stringify(l));
    summary.c1 = { id, duration: Number(probe(f).format.duration), calls: calls.length, loud: l };
  }
  if (cases.includes("3")) {
    const id = await createEpisode(s.p, { tag: "c3", title: "E2E caso 3 mixto", conversation: true, script: convScript.split("\n\n").slice(0, 14).join("\n\n"), voiceA: LEO, voiceB: ANA, nameA: "Hans (grabación)", nameB: "B" });
    const row0 = await ep(id); const aTurns = row0.production.turns.filter((t) => t.speaker === "A");
    const hashes = {};
    for (const t of aTurns) {
      const wav = path.join(OUT, `rec-${t.id}.wav`); execFileSync("espeak-ng", ["-v", "es", "-p", "10", "-s", "150", "-w", wav, t.text]);
      const bytes = fs.readFileSync(wav); hashes[t.id] = sha(bytes);
      // Flujo real de la API: ticket → subida firmada → attach (desde el navegador autenticado)
      const ticket = await s.p.evaluate(async ([id, size]) => (await fetch(`/api/podcast/${id}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ticket", mime: "audio/wav", size }) })).json(), [id, bytes.length]);
      if (!ticket.path) { ok(`c3: ticket ${t.id}`, false, JSON.stringify(ticket)); break; }
      const up = await fetch(`http://127.0.0.1:54821/storage/v1/object/upload/sign/videos/${ticket.path}?token=${ticket.token}`, { method: "PUT", headers: { "content-type": "audio/wav" }, body: bytes }); // subida firmada (mismo endpoint que uploadToSignedUrl)
      if (!up.ok) { ok(`c3: subida firmada ${t.id}`, false, String(up.status)); break; }
      const at = await s.p.evaluate(async ([id, turnId, p]) => (await fetch(`/api/podcast/${id}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "attach", turnId, path: p }) })).status, [id, t.id, ticket.path]);
      if (at !== 200) ok(`c3: attach ${t.id}`, false, String(at));
    }
    await s.p.reload();
    const before = ttsCalls().length;
    // PR #198 (en prod): la autorización por episodio es inmutable; sin presupuesto total queda fijada al estimado de la
    // primera narración y una edición posterior se rechaza (fail-closed, correcto). El dueño fija un presupuesto total.
    await db.query("update public.podcast_episodes set budget_usd=1 where id=$1", [id]);
    const row = await generate(s.p, id, "c3");
    const calls = ttsCalls().slice(before);
    ok("c3: ninguna llamada TTS para los turnos con grabación propia", calls.every((c) => c.voiceId === ANA) && calls.length === row.production.turns.length - aTurns.length, `${calls.length} llamadas (solo B)`);
    ok("c3: hash de cada grabación original conservado", (() => { const own = row.production_timeline.filter((e) => e.source === "own_recording"); return own.length === aTurns.length && own.length > 0 && own.every((e) => e.sha256 === hashes[e.turn_id]); })(), `${aTurns.length} grabaciones`);
    // reemplazar un solo turno de B
    const bT = row.production.turns.find((t) => t.speaker === "B");
    const n0 = ttsCalls().length;
    const st = await s.p.evaluate(async ([id, turnId]) => (await fetch(`/api/podcast/${id}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "edit", turnId, text: "Reemplazo editorial de un turno de B, sin regenerar el resto." }) })).status, [id, bT.id]);
    await s.p.reload(); await generate(s.p, id, "c3-reemplazo");
    ok("c3: reemplazar un turno = exactamente 1 síntesis nueva", st === 200 && ttsCalls().length - n0 === 1, `${ttsCalls().length - n0}`);
    // c3-sin-margen: conversación SIN presupuesto total → la autorización inmutable = estimado inicial, ya consumido.
    // Editar un turno debe rechazarse YA (409 visible, 0 TTS, sin timeout) y fijar un presupuesto después NO la amplía.
    const id2 = await createEpisode(s.p, { tag: "c3b", title: "E2E caso 3 sin margen", conversation: true, script: "A: Primer turno corto del caso sin margen.\n\nB: Segundo turno corto, también sin margen.", voiceA: LEO, voiceB: ANA, nameA: "A", nameB: "B" });
    const row2 = await generate(s.p, id2, "c3b");
    const b2 = row2.production.turns.find((t) => t.speaker === "B");
    await s.p.evaluate(async ([id, turnId]) => (await fetch(`/api/podcast/${id}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "edit", turnId, text: "Edición posterior sin saldo autorizado." }) })).status, [id2, b2.id]);
    const post = () => s.p.evaluate(async (id) => { const r = await fetch(`/api/podcast/${id}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); return { st: r.status, body: await r.json().catch(() => ({})) }; }, id2);
    let n1 = ttsCalls().length, t1 = Date.now(), r1 = await post();
    ok("c3-sin-margen: editar sin saldo ⇒ 409 inmediato con mensaje, 0 TTS", r1.st === 409 && typeof r1.body.error === "string" && r1.body.error.length > 0 && ttsCalls().length === n1 && Date.now() - t1 < 5000, `${r1.st} «${r1.body.error ?? ""}» ${Date.now() - t1}ms`);
    await db.query("update public.podcast_episodes set budget_usd=5 where id=$1", [id2]);
    n1 = ttsCalls().length; const r2 = await post();
    const cap2 = (await db.query("select cap_usd from public.pi_spend_authorizations where project_id=$1", ["podcast-" + id2])).rows[0];
    ok("c3-sin-margen: presupuesto fijado después NO amplía la autorización abierta (409, 0 TTS, tope intacto)", r2.st === 409 && ttsCalls().length === n1 && cap2 && Number(cap2.cap_usd) < 1, `${r2.st} cap=${cap2 && cap2.cap_usd}`);
    const f = await download(s.p, "c3"); summary.c3 = { id, calls: calls.length, ownTurns: aTurns.length, sha: sha(fs.readFileSync(f)) };
  }
  if (cases.includes("5")) {
    const o = await session(OTHER, "intruso");
    await o.p.goto(`${BASE}/dashboard/podcast`); await shot(o.p, "c5-intruso-formulario");
    const html = await o.p.content();
    ok("c5: El Duro no aparece para otra cuenta", !html.includes(DURO) && !/duro hans/i.test(html));
    const forced = await o.p.evaluate(async (v) => { const r = await fetch("/api/podcast", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x", script: "A: hola que tal estás hoy\n\nB: muy bien gracias por preguntar", language: "es", voiceId: v, production: { mode: "conversation", style: "standard", dialogue: "A: hola que tal estás hoy\n\nB: muy bien gracias por preguntar", participants: [{ id: "A", voiceId: v }, { id: "B", voiceId: "VozCatalogoAna01" }] } }) }); return [r.status, await r.text()]; }, DURO);
    ok("c5: forzar El Duro por API → rechazado", forced[0] === 400, forced.join(" "));
    const studioForced = await o.p.evaluate(async (v) => {
      const spec = { mode: "narracion", output: "audio", title: "Intruso estudio", language: "es", script: "Texto de prueba suficientemente largo para el esquema del estudio.", target_minutes: 1, participants: [{ id: "A", name: "X", voice_id: v, voice_kind: "clonada" }], visual: { provider: "solo_set" }, music: {}, budget_usd: 5 };
      const r = await fetch("/api/podcast/v3", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", spec }) });
      return [r.status, await r.text()];
    }, DURO);
    ok("c5: estudio — otra cuenta fuerza El Duro simulado → rechazado", studioForced[0] === 400 && !/clonada"\s*:\s*"ok/.test(studioForced[1]), String(studioForced[1]).slice(0, 180));
    const anyOwner = (await db.query("select id, audio_path from podcast_episodes where user_id=$1 and audio_path is not null limit 1", [OWNER.id])).rows[0];
    if (anyOwner) {
      const r = await o.p.goto(`${BASE}/dashboard/podcast/${anyOwner.id}`); const body = await o.p.content();
      ok("c5: página de episodio ajeno no accesible", r.status() === 404 || /no encontrado|404/i.test(body), String(r.status()));
      const t = await o.p.evaluate(async (id) => (await fetch(`/api/podcast/${id}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ticket", mime: "audio/wav", size: 10 }) })).status, anyOwner.id);
      ok("c5: API por turno de episodio ajeno → 404", t === 404, String(t));
      const tok = await o.p.evaluate(() => { const k = Object.keys(localStorage).find((x) => x.includes("auth-token")); return k ? JSON.parse(localStorage.getItem(k)).access_token : null; }).catch(() => null) ?? (await o.ctx.cookies()).map((c) => c.value).join("");
      const st = (await fetch(`http://127.0.0.1:54821/storage/v1/object/videos/${anyOwner.audio_path}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} })).status; // fuera del navegador (CORS); sin firma y sin service role
      ok("c5: archivo privado ajeno no descargable sin firma", st >= 400, String(st));
    }
    await o.ctx.close();
  }
  if (cases.includes("6")) {
    const mk = async (tag) => createEpisode(s.p, { tag, title: `E2E caso 6 ${tag}`, conversation: true, script: "A: Una prueba breve de error controlado.\n\nB: Entendido, veamos qué ocurre ahora.", voiceA: LEO, voiceB: ANA, nameA: "A", nameB: "B" });
    for (const [mode, expect] of [["500", /no se pudo generar|inténtalo/i], ["timeout", /incierto|revisión/i]]) {
      const id = await mk(`c6-${mode}`); fs.writeFileSync(FAILF, mode); const n0 = ttsCalls().length;
      await s.p.getByRole("button", { name: /Generar narración/ }).click(); await s.p.waitForTimeout(4000); await s.p.reload(); await shot(s.p, `c6-${mode}`);
      const row = await ep(id);
      ok(`c6: proveedor ${mode} → fallo claro sin éxito falso`, row.status === "failed" && expect.test(row.error ?? ""), row.error);
      if (mode === "timeout") { const dis = await s.p.getByRole("button", { name: /Continuar \/ reintentar/ }).isDisabled(); const st = await s.p.evaluate(async (id) => (await fetch(`/api/podcast/${id}/generate`, { method: "POST" })).status, id); await s.p.waitForTimeout(2000); const r2 = await ep(id); ok("c6: tras ambiguo el reintento está bloqueado (UI deshabilitada + API 409) y no se vuelve a pedir el segmento incierto", dis && st === 409 && r2.status === "failed" && ttsCalls().length - n0 === 1, `disabled=${dis} status=${st} ${ttsCalls().length - n0} llamadas`); }
    }
    // saldo insuficiente / precio desconocido
    await db.query("update pi_supply_policies set daily_cap_usd=0.0001 where provider='elevenlabs'");
    const id3 = await mk("c6-saldo"); await s.p.getByRole("button", { name: /Generar narración/ }).click().catch(() => {}); await s.p.waitForTimeout(3000);
    const r3 = await ep(id3); ok("c6: tope de gasto → no genera ni llama", r3.status !== "ready", `${r3.status} ${r3.error ?? ""}`);
    await db.query("update pi_supply_policies set daily_cap_usd=50 where provider='elevenlabs'");
    // archivo faltante
    const id4 = await mk("c6-falta"); const row4 = await ep(id4); const p4 = { ...row4.production }; p4.participants[0].recordings = { T001: `${OWNER.id}/podcasts/${id4}/uploads/00000000-0000-4000-8000-000000000000` };
    await db.query("update podcast_episodes set production=$2 where id=$1", [id4, p4]); await s.p.reload();
    await s.p.getByRole("button", { name: /Generar narración/ }).click(); await s.p.waitForTimeout(3000);
    ok("c6: grabación faltante → fallo, sin TTS sustituto", (await ep(id4)).status === "failed");
    // concurrencia: dos generaciones simultáneas del mismo episodio
    const id5 = await mk("c6-concurrente"); const n5 = ttsCalls().length;
    const sts = await s.p.evaluate(async (id) => Promise.all([0, 1].map(async () => (await fetch(`/api/podcast/${id}/generate`, { method: "POST" })).status)), id5);
    ok("c6: dos peticiones simultáneas → una sola ejecución", sts.filter((x) => x === 200).length === 1 && ttsCalls().length - n5 === 2, `${sts} llamadas=${ttsCalls().length - n5}`);
  }
  if (cases.includes("7")) {
    // Caso 7 — AV completo desde la UI: crear (A/B + música) → «Producir ahora» → worker de video real (narra + imágenes mock + montaje + MP4)
    // → interrupción y «Reintentar» → reproducción en el reproductor de la página → descarga. Pexels y ElevenLabs simulados (USD 0).
    const PXLOG = path.join(E2E, "logs/pexels.jsonl"), pxCalls = () => (fs.existsSync(PXLOG) ? fs.readFileSync(PXLOG, "utf8").trim().split("\n").filter(Boolean).length : 0);
    const DLOG = path.join(E2E, "logs/dispatch.jsonl"), dispatches = () => (fs.existsSync(DLOG) ? fs.readFileSync(DLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : []);
    const short = convScript.split("\n\n").slice(0, 24).join("\n\n");
    const EGR = path.join(E2E, "logs/egress.jsonl"), egress = () => (fs.existsSync(EGR) ? fs.readFileSync(EGR, "utf8").trim().split("\n").filter((l) => l.includes("egress_refused")) : []), e0 = egress().length;
    const t0 = ttsCalls().length;
    const id = await createEpisode(s.p, { tag: "c7", title: "E2E caso 7 video A/B", conversation: true, emotional: true, music: true, script: short, voiceA: DURO, voiceB: ANA, nameA: "Hans", nameB: "Invitada" });
    const produce = async (label, tag) => {
      const d0 = dispatches().length;
      await s.p.getByRole("button", { name: label }).click();
      for (let i = 0; i < 60 && dispatches().length === d0; i++) await s.p.waitForTimeout(500);
      await shot(s.p, `${tag}-solicitado`);
      const d = dispatches().slice(d0); return d.find((x) => JSON.stringify(x).includes(id));
    };
    const d1 = await produce(/Producir ahora/, "c7-01");
    ok("c7: «Producir ahora» despacha un trabajo de video para este episodio", !!d1 && /video/.test(JSON.stringify(d1)), JSON.stringify(d1 ?? null).slice(0, 160));
    // Primera ejecución del worker: se interrumpe (SIGKILL) al entrar en la etapa de imágenes o montaje.
    const envw = { ...process.env, ...Object.fromEntries(fs.readFileSync(path.join(E2E, "secrets/podcast-worker.env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])), EPISODE_ID: id, JOB_KIND: "video", NPM_CONFIG_UPDATE_NOTIFIER: "false" };
    const w = spawn("npx", ["tsx", "scripts/podcast-video-worker.ts"], { cwd: REPO, env: envw, detached: true }); let wout = ""; w.stdout.on("data", (x) => (wout += x)); w.stderr.on("data", (x) => (wout += x));
    let stageSeen = null; for (let i = 0; i < 1200; i++) { const r = await ep(id); if (/Buscando imágenes|Montando/.test(r.video_stage ?? "")) { stageSeen = r.video_stage; break; } if (w.exitCode !== null) break; await new Promise((r) => setTimeout(r, 250)); }
    process.kill(-w.pid, "SIGKILL"); await new Promise((r) => setTimeout(r, 1500)); fs.writeFileSync(path.join(OUT, "worker-c7-interrumpido.log"), wout);
    const mid = await ep(id); const ttsAfterFirst = ttsCalls().length - t0;
    ok("c7: worker interrumpido después de narrar (audio ya guardado)", !!stageSeen && mid.status === "ready" && !!mid.audio_sha256, `etapa=${stageSeen} audio=${mid.audio_sha256?.slice(0, 12)} tts=${ttsAfterFirst}`);
    await db.query("update podcast_episodes set video_heartbeat_at = now() - interval '20 minutes' where id=$1", [id]); // = función muerta (sin latido)
    await s.p.reload(); await shot(s.p, "c7-02-detenido");
    ok("c7: la UI muestra la producción detenida y ofrece reintentar", await s.p.getByText(/dejó de responder/).isVisible());
    const d2 = await produce(/Reintentar/, "c7-03");
    const r2 = await worker(id, "video");
    const fin = await ep(id); const ttsTotal = ttsCalls().length - t0;
    ok("c7: reintento termina con video listo", r2.code === 0 && fin.video_status === "ready" && !!fin.video_path, `${fin.video_status} ${fin.video_error ?? ""}`);
    ok("c7: el reintento no repite ninguna llamada de voz (audio y turnos reutilizados)", ttsTotal === ttsAfterFirst && fin.audio_sha256 === mid.audio_sha256, `tts total=${ttsTotal} tras 1ª=${ttsAfterFirst}`);
    ok("c7: voces separadas también en el video", (() => { const c = ttsCalls().slice(t0); const a = fin.production.turns.filter((t) => t.speaker === "A").length; return c.filter((x) => x.voiceId === DURO).length === a && c.filter((x) => x.voiceId === ANA).length === fin.production.turns.length - a; })());
    ok("c7: imágenes vía proveedor simulado (Pexels mock); ningún intento de salida a red real", pxCalls() > 0 && egress().length === e0, `${pxCalls()} llamadas mock; salidas rechazadas=${JSON.stringify(egress().slice(e0))}`);
    const subs = path.join(require("node:os").tmpdir(), `podcast-${id}-${fin.video_attempts}`, "entrada", "subtitulos.json");
    const subsTxt = fs.existsSync(subs) ? fs.readFileSync(subs, "utf8") : ""; if (subsTxt) fs.writeFileSync(path.join(OUT, "c7-subtitulos.json"), subsTxt);
    ok("c7: subtítulos atribuidos por hablante ([Hans] y [Invitada])", subsTxt.includes("[Hans]") && subsTxt.includes("[Invitada]"), `${(subsTxt.match(/\[Hans\]/g) ?? []).length}/${(subsTxt.match(/\[Invitada\]/g) ?? []).length}`);
    await s.p.reload(); await shot(s.p, "c7-04-entregado");
    const vid = s.p.locator('section[aria-label="Revisión de la entrega"] video');
    const play = await vid.evaluate(async (v) => { v.muted = true; await v.play().catch(() => {}); await new Promise((r) => setTimeout(r, 4000)); const o = { readyState: v.readyState, t: v.currentTime, d: v.duration, w: v.videoWidth, h: v.videoHeight, err: v.error?.code ?? null }; v.pause(); return o; });
    await shot(s.p, "c7-05-reproduciendo");
    ok("c7: el reproductor de la página reproduce el MP4", play.readyState >= 2 && play.t > 1 && play.w > 0 && !play.err, JSON.stringify(play));
    const [dl] = await Promise.all([s.p.waitForEvent("download"), s.p.getByText(/Descargar video/).click()]);
    const mp4 = path.join(OUT, "c7-episodio.mp4"); await dl.saveAs(mp4);
    const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", mp4]).toString());
    ok("c7: descarga = video guardado (sha) con video H.264 + audio", sha(fs.readFileSync(mp4)) === fin.video_sha256 && pr.streams.some((x) => x.codec_type === "video") && pr.streams.some((x) => x.codec_type === "audio"), `${pr.streams.map((x) => x.codec_name).join("+")} ${Number(pr.format.duration).toFixed(1)} s`);
    ok("c7: duración del video = audio (±2 s)", Math.abs(Number(pr.format.duration) - Number(fin.duration_seconds)) <= 2, `${Number(pr.format.duration).toFixed(1)} vs ${Number(fin.duration_seconds).toFixed(1)}`);
    // Música: misma producción sin música (turnos reutilizados → 0 llamadas) como referencia para medir que la música no corta ni distorsiona la voz.
    const tRef = ttsCalls().length;
    const idRef = await createEpisode(s.p, { tag: "c7-ref", title: "E2E caso 7 referencia sin música", conversation: true, emotional: true, script: short, voiceA: DURO, voiceB: ANA, nameA: "Hans", nameB: "Invitada" });
    await generate(s.p, idRef, "c7-ref"); const ref = await ep(idRef);
    ok("c7: referencia sin música lista (otro episodio → su propia síntesis simulada; solo sirve de referencia de medición)", ref.status === "ready", `${ttsCalls().length - tRef} llamadas mock`);
    const refFile = await download(s.p, "c7-ref"); fs.writeFileSync(path.join(OUT, "c7-timeline.json"), JSON.stringify(fin.production_timeline));
    const av = require("node:child_process").spawnSync("python3", [path.join(REPO, "scripts/harness/e2e/podcast/av-check.py"), mp4, refFile, path.join(OUT, "c7-timeline.json")], { encoding: "utf8" });
    fs.writeFileSync(path.join(OUT, "c7-av-check.json"), av.stdout);
    ok("c7: música no corta ni enmascara la voz, sin distorsión, y se oye entre turnos", av.status === 0, av.stdout.trim());
    // Aislamiento del video y topes
    const o = await session(OTHER, "intruso-c7");
    const vr = await o.p.evaluate(async (id) => (await fetch(`/api/podcast/${id}/video`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, id);
    ok("c7: otra cuenta no puede producir/ver el video ajeno (404)", vr === 404, String(vr));
    const vs = (await fetch(`http://127.0.0.1:54821/storage/v1/object/videos/${fin.video_path}`)).status;
    ok("c7: MP4 privado no descargable sin firma", vs >= 400, String(vs)); await o.ctx.close();
    const idB = await createEpisode(s.p, { tag: "c7-tope", title: "E2E caso 7 tope", conversation: true, script: "A: Texto nuevo nunca sintetizado para probar el tope de gasto.\n\nB: De acuerdo, sin presupuesto no debería narrarse nada.", voiceA: LEO, voiceB: ANA, nameA: "A", nameB: "B" });
    const tB = ttsCalls().length; await s.p.locator('input[name="budget_usd"]').fill("0"); const dB = dispatches().length;
    await s.p.getByRole("button", { name: /Producir ahora/ }).click(); await s.p.waitForTimeout(2500); await s.p.reload(); await shot(s.p, "c7-06-tope");
    const rB = await ep(idB); if (rB.video_status === "queued") await worker(idB, "video"); const rB2 = await ep(idB);
    ok("c7: presupuesto 0 → no narra ni produce (0 llamadas)", ttsCalls().length === tB && rB2.video_status !== "ready", `${rB2.video_status} «${rB2.video_error ?? ""}» despachos=${dispatches().length - dB}`);
    summary.c7 = { id, video_sha256: fin.video_sha256, video_path: fin.video_path, seconds: Number(pr.format.duration), tts: ttsTotal, pexels: pxCalls(), play, stageKilled: stageSeen };
  }
  if (cases.includes("8")) {
    // Caso 8 — UI por turno con clics reales: editar UN turno, subir grabación propia de UN turno, regenerar solo lo cambiado;
    // operación incierta visible y reintento bloqueado (UI y servidor).
    const script8 = "A: Bienvenidos a una prueba breve de edición por turnos.\n\nB: Gracias, hoy vamos a cambiar solo una parte.\n\nA: La primera idea es que nada se vuelva a cobrar.\n\nB: Y la segunda, que mi voz siga siendo la mía.\n\nA: Perfecto, cerramos aquí la prueba.\n\nB: Hasta la próxima, gracias por escuchar.";
    const id = await createEpisode(s.p, { tag: "c8", title: "E2E caso 8 turnos", conversation: true, script: script8, voiceA: LEO, voiceB: ANA, nameA: "Hans", nameB: "Invitada" });
    // PR #198: autorización inmutable por episodio → el dueño fija un presupuesto total que cubra ediciones (ver c3-sin-margen).
    await db.query("update public.podcast_episodes set budget_usd=1 where id=$1", [id]);
    await generate(s.p, id, "c8-inicial"); const r0 = await ep(id);
    ok("c8: episodio inicial listo (6 turnos, 6 llamadas)", r0.status === "ready" && r0.production.turns.length === 6);
    const panel = s.p.locator("section, div").filter({ has: s.p.getByRole("heading", { name: "Turnos" }) }).last();
    ok("c8: la página muestra el panel de turnos con los 6 turnos", (await s.p.locator("li[data-turn]").count()) === 6);
    // Editar T004 (B)
    const n0 = ttsCalls().length;
    await s.p.getByRole("button", { name: "Editar turno T004" }).click();
    await s.p.getByLabel("Texto del turno T004").fill("Y la segunda, que mi voz siga siendo exactamente la mía, sin trucos.");
    await shot(s.p, "c8-01-editando");
    await s.p.getByRole("button", { name: "Guardar turno T004" }).click();
    await s.p.getByText(/Turno T004 actualizado/).waitFor(); await shot(s.p, "c8-02-editado");
    const r1 = await ep(id);
    ok("c8: guardar un turno → episodio a borrador, solo cambia ese texto", r1.status === "draft" && r1.production.turns.find((t) => t.id === "T004").text.includes("sin trucos") && r1.production.turns.filter((t, i) => t.text !== r0.production.turns[i].text).length === 1);
    // Subir grabación propia para T001 (A) desde el selector de archivos real
    const wav = path.join(OUT, "c8-rec-T001.wav"); execFileSync("espeak-ng", ["-v", "es", "-p", "10", "-s", "150", "-w", wav, r0.production.turns[0].text]); const recSha = sha(fs.readFileSync(wav));
    await s.p.getByLabel("Grabación del turno T001").setInputFiles(wav);
    await s.p.getByText(/Grabación asignada al turno T001/).waitFor({ timeout: 60000 }); await shot(s.p, "c8-03-grabacion");
    const r2 = await ep(id); const recPath = r2.production.participants.find((p) => p.id === "A").recordings?.T001;
    ok("c8: grabación subida por el navegador (URL firmada) y asignada solo a T001", !!recPath && Object.keys(r2.production.participants.find((p) => p.id === "A").recordings).length === 1 && sha(fs.readFileSync(path.join(E2E, "storage/videos", recPath))) === recSha);
    ok("c8: la UI marca T001 como grabación propia", await s.p.locator('li[data-turn="T001"] [data-turn-state]').filter({ hasText: /Grabación propia/ }).waitFor({ timeout: 20000 }).then(() => true, () => false));
    // Regenerar: solo T004 se sintetiza; T001 sin TTS; el resto reutilizado
    await generate(s.p, id, "c8-regenerado"); const r3 = await ep(id); const calls = ttsCalls().slice(n0);
    ok("c8: regenerar → exactamente 1 síntesis (T004) y 0 para la grabación", r3.status === "ready" && calls.length === 1 && calls[0].voiceId === ANA, `${calls.length} llamadas`);
    const tl = Object.fromEntries(r3.production_timeline.map((e) => [e.turn_id, e]));
    ok("c8: línea de tiempo: T001 grabación (sha original), T004 nuevo, resto reutilizado", tl.T001.source === "own_recording" && tl.T001.sha256 === recSha && tl.T004.reused === false && ["T002", "T003", "T005", "T006"].every((k) => tl[k].reused === true), JSON.stringify(Object.fromEntries(Object.entries(tl).map(([k, v]) => [k, v.source === "own_recording" ? "rec" : v.reused ? "reuso" : "nuevo"]))));
    await s.p.reload(); await shot(s.p, "c8-04-estados");
    ok("c8: la UI muestra T004 sintetizado y los demás reutilizados", /sintetizado/.test(await s.p.locator('li[data-turn="T004"] [data-turn-state]').innerText()) && /reutilizado/.test(await s.p.locator('li[data-turn="T002"] [data-turn-state]').innerText()));
    // Operación incierta: editar T006 y cortar la red del proveedor al sintetizarlo
    await s.p.getByRole("button", { name: "Editar turno T006" }).click(); await s.p.getByLabel("Texto del turno T006").fill("Hasta la próxima, y gracias de verdad por escuchar.");
    await s.p.getByRole("button", { name: "Guardar turno T006" }).click(); await s.p.getByText(/Turno T006 actualizado/).waitFor();
    fs.writeFileSync(FAILF, "timeout"); const n1 = ttsCalls().length;
    await generate(s.p, id, "c8-incierto"); await s.p.reload(); await shot(s.p, "c8-05-incierto");
    const r4 = await ep(id);
    ok("c8: corte durante la síntesis → episodio fallido con mensaje «incierto»", r4.status === "failed" && /incierto/i.test(r4.error ?? ""), r4.error);
    ok("c8: la UI muestra «Requiere revisión» con la operación incierta", await s.p.getByText(/Requiere revisión: 1 operación/).isVisible());
    ok("c8: botón de reintento deshabilitado y explicado en la UI", (await s.p.getByRole("button", { name: /Continuar \/ reintentar/ }).isDisabled()) && await s.p.getByText(/Reintento bloqueado/).isVisible());
    ok("c8: edición y subida por turno bloqueadas mientras haya incierto", await s.p.getByRole("button", { name: "Editar turno T002" }).isDisabled());
    const forced = await s.p.evaluate(async (id) => { const r = await fetch(`/api/podcast/${id}/generate`, { method: "POST" }); return [r.status, (await r.json()).error]; }, id);
    ok("c8: el servidor también rechaza el reintento forzado (409) sin llamar al proveedor", forced[0] === 409 && ttsCalls().length - n1 === 1, `${forced.join(" ")} llamadas=${ttsCalls().length - n1}`);
    summary.c8 = { id, recSha, timeline: Object.fromEntries(Object.entries(tl).map(([k, v]) => [k, v.source === "own_recording" ? "rec" : v.reused ? "reuso" : "nuevo"])) };
  }
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ results, summary }, null, 1));
  if (cases.includes("9")) {
    // Caso 9 — ENSAYO SIMULADO de la prueba real del dueño: misma configuración que el episodio «señal Wow!»
    // (narración individual, español, emocional, voz El Duro *simulada* por espeak-ng, 16:9), de la UI a la descarga. USD 0.
    // Música: E2E_WOW_MUSIC=1 la activa (en producción hoy no hay PODCAST_MUSIC_DIR → se recomienda sin música).
    const script = fs.readFileSync(process.env.WOW_SCRIPT || path.join(REPO, "docs/podcast-2-1-prueba-real/guion-wow.txt"), "utf8").trim();
    const title = "El misterio de la señal Wow!: ¿recibimos un mensaje del espacio?";
    const PXLOG = path.join(E2E, "logs/pexels.jsonl"), pxLines = () => (fs.existsSync(PXLOG) ? fs.readFileSync(PXLOG, "utf8").trim().split("\n").filter(Boolean) : []);
    const DLOG = path.join(E2E, "logs/dispatch.jsonl"), nDisp = () => (fs.existsSync(DLOG) ? fs.readFileSync(DLOG, "utf8").trim().split("\n").filter(Boolean).length : 0);
    const EGR = path.join(E2E, "logs/egress.jsonl"), egress = () => (fs.existsSync(EGR) ? fs.readFileSync(EGR, "utf8").trim().split("\n").filter((l) => l.includes("egress_refused")) : []), e0 = egress().length;
    const t0 = ttsCalls().length, p0 = pxLines().length;
    const id = await createEpisode(s.p, { tag: "c9", title, conversation: false, emotional: true, music: process.env.E2E_WOW_MUSIC === "1", script, voiceA: DURO });
    await generate(s.p, id, "c9");
    const a = await ep(id); const calls = ttsCalls().slice(t0);
    ok("c9: narración lista con El Duro (simulado) en todas las llamadas", a.status === "ready" && calls.length > 0 && calls.every((c) => c.voiceId === DURO), `${a.status} ${calls.length} llamadas ${Number(a.duration_seconds).toFixed(0)} s ${a.error ?? ""}`);
    const d0 = nDisp(); await s.p.reload(); await s.p.getByRole("button", { name: /Producir ahora/ }).click();
    for (let i = 0; i < 60 && nDisp() === d0; i++) await s.p.waitForTimeout(500);
    ok("c9: «Producir ahora» despacha el video", nDisp() > d0);
    const r = await worker(id, "video"); const fin = await ep(id);
    ok("c9: video listo sin intervención manual", r.code === 0 && fin.video_status === "ready", `${fin.video_status} ${fin.video_error ?? ""}`);
    ok("c9: el video no repite llamadas de voz", ttsCalls().length - t0 === calls.length);
    const qs = pxLines().slice(p0).map((l) => { try { return JSON.parse(l).q; } catch { return null; } }).filter(Boolean);
    fs.writeFileSync(path.join(OUT, "c9-busquedas-imagenes.json"), JSON.stringify(qs, null, 1));
    ok("c9: búsquedas de imágenes sin números escritos ni términos abstractos", qs.length > 0 && !qs.some((q) => /setenta|novecientos|hipótesis|recibimos/.test(q)), `${qs.length} búsquedas, ${new Set(qs).size} distintas`);
    ok("c9: sin salida a red real", egress().length === e0);
    await s.p.reload(); await shot(s.p, "c9-entregado");
    const vid = s.p.locator('section[aria-label="Revisión de la entrega"] video');
    const play = await vid.evaluate(async (v) => { v.muted = true; await v.play().catch(() => {}); await new Promise((r) => setTimeout(r, 4000)); const o = { readyState: v.readyState, t: v.currentTime, d: v.duration, w: v.videoWidth, h: v.videoHeight, err: v.error?.code ?? null }; v.pause(); return o; });
    await shot(s.p, "c9-reproduciendo");
    ok("c9: el reproductor de la página reproduce 16:9", play.readyState >= 2 && play.t > 1 && play.w * 9 === play.h * 16 && !play.err, JSON.stringify(play));
    const [dl] = await Promise.all([s.p.waitForEvent("download"), s.p.getByText(/Descargar video/).click()]);
    const mp4 = path.join(OUT, "c9-wow.mp4"); await dl.saveAs(mp4);
    const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", mp4]).toString());
    ok("c9: descarga íntegra (sha) H.264+AAC, duración = audio", sha(fs.readFileSync(mp4)) === fin.video_sha256 && pr.streams.some((x) => x.codec_name === "h264") && pr.streams.some((x) => x.codec_name === "aac") && Math.abs(Number(pr.format.duration) - Number(fin.duration_seconds)) <= 2, `${Number(pr.format.duration).toFixed(1)} s`);
    const led = (await db.query("select provider, status, count(*)::int n, sum(reserved_usd)::float r, sum(committed_usd)::float c from pi_paid_operations where project_id like '%'||$1||'%' or shot_id like '%'||$1||'%' group by 1,2", [id])).rows;
    fs.writeFileSync(path.join(OUT, "c9-registro-costos.json"), JSON.stringify({ episodio: id, caracteres: script.length, llamadas_tts: calls.length, ledger: led }, null, 1));
    const keys = (await db.query("select idempotency_key k from pi_paid_operations where provider = 'elevenlabs' and (project_id like '%'||$1||'%' or shot_id like '%'||$1||'%')", [id])).rows.map((x) => x.k);
    ok("c9: cada llamada de voz queda registrada una sola vez en el libro de costos (simulado)", keys.length === calls.length && new Set(keys).size === keys.length, `${keys.length} operaciones, ${new Set(keys).size} claves, ${calls.length} llamadas ${JSON.stringify(led)}`);
  }

  // Flujo del estudio (10 pasos). `S` = sesión, `tag` = prefijo de capturas/comprobaciones, `m` = modalidad.
  async function studioFlow(S, tag, m, opts = {}) {
    const W = () => S.p.getByTestId("podcast-wizard");
    const next = async () => W().getByRole("button", { name: "Siguiente" }).click();
    const stepTitle = async () => (await W().getByTestId("wizard-step-title").textContent()) ?? "";
    const snap = (n) => shot(S.p, `${tag}-${n}`);
    const disp0 = fs.existsSync(path.join(E2E, "logs/dispatch.jsonl")) ? fs.readFileSync(path.join(E2E, "logs/dispatch.jsonl"), "utf8").length : 0;
    await S.p.goto(`${BASE}/dashboard/podcast`); await S.p.evaluate(() => localStorage.removeItem("atomivid.podcast.asistente.v2")); await S.p.reload(); await S.p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor();
    await W().getByRole("radio", { name: new RegExp(m.mode) }).click(); await snap("paso01-modalidad"); await next();
    await W().getByLabel("Título del episodio").fill(m.title);
    if (m.topic) {
      await W().getByLabel("Tema").fill(m.topic);
      await W().getByRole("button", { name: "Generar conversación desde el tema" }).click();
      await S.p.waitForFunction(() => (document.querySelector('[aria-label="Guion"]')?.value ?? "").length > 50, null, { timeout: 30000 });
      const sc = await W().getByLabel("Guion").inputValue();
      ok(`${tag}: conversación generada por turnos con identidad (plantilla sin costo)`, /^\S[^:]{0,40}: /m.test(sc) && new Set(sc.split("\n").filter(Boolean).map((l) => l.split(":")[0])).size === 2 && /\?/.test(sc), `${sc.split("\n").length} turnos`);
    } else await W().getByLabel("Guion").fill(m.script);
    await snap("paso02-tema");
    await next(); await W().getByRole("button", { name: "Atrás" }).click(); await S.p.reload(); await S.p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor();
    ok(`${tag}: atrás + recarga conserva el borrador`, (await W().getByLabel("Título del episodio").inputValue()) === m.title && /Paso 2/.test(await stepTitle()));
    await next();
    if (m.count === 2 && (m.mode === "Solo audio" || m.mode === "Narración con imágenes")) await W().getByLabel("Dos voces que se alternan").check();
    if (m.count === 2) { await W().getByLabel("Personalidad A").fill("Curioso, hace preguntas"); await W().getByLabel("Personalidad B").fill("Escéptica, discrepa con datos"); await W().getByLabel("Género B").selectOption("femenino"); }
    await snap("paso03-participantes"); await next();
    await W().getByLabel("Voz A").selectOption(m.voices[0]); if (m.count === 2) await W().getByLabel("Voz B").selectOption(m.voices[1]);
    const duroOpts = await W().locator('option[value="CeFSZuaHs4SxcBxb9nCr"]').evaluateAll((os) => os.map((o) => ({ disabled: o.disabled, text: o.textContent })));
    ok(`${tag}: El Duro real sin concesión aparece «No disponible» y no se puede elegir`, duroOpts.length > 0 && duroOpts.every((o) => o.disabled && /No disponible/.test(o.text)), JSON.stringify(duroOpts));
    const vw = S.p.viewportSize()?.width ?? 0;
    const voiceOverflow = await S.p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(`${tag}: el paso voces no desborda el ancho (${vw}px)`, voiceOverflow <= 1, `${voiceOverflow}px`);
    if (m.voices.includes(DURO)) {
      let kind = "";
      try {
        await S.p.waitForFunction((id) => {
          const d = JSON.parse(localStorage.getItem("atomivid.podcast.asistente.v2") || "null");
          return (d?.participants || []).some((p) => p.voice_id === id && p.voice_kind === "clonada");
        }, DURO, { timeout: 5000 });
        kind = "clonada";
      } catch { kind = await S.p.evaluate(() => localStorage.getItem("atomivid.podcast.asistente.v2") || ""); }
      ok(`${tag}: con concesión, El Duro simulado se elige como voice_kind clonada`, kind === "clonada", String(kind).slice(0, 240));
    }
    await snap("paso04-voces");
    await W().getByRole("button", { name: "Atrás" }).click(); await S.p.reload(); await S.p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor();
    const keptVoice = await S.p.evaluate(() => { const d = JSON.parse(localStorage.getItem("atomivid.podcast.asistente.v2") || "null"); return d?.participants?.[0]?.voice_id ?? ""; });
    ok(`${tag}: atrás + recarga conserva la voz elegida`, keptVoice === m.voices[0], keptVoice);
    if (m.voices.includes(DURO)) {
      const kept = await S.p.evaluate((id) => { const d = JSON.parse(localStorage.getItem("atomivid.podcast.asistente.v2") || "null"); return (d?.participants || []).find((p) => p.voice_id === id)?.voice_kind; }, DURO);
      ok(`${tag}: atrás + recarga conserva voice_kind clonada`, kept === "clonada", String(kept));
    }
    await next(); await next();
    if (m.avatars) { await W().getByLabel("Avatar A").selectOption(m.avatars[0]); if (m.avatars[1]) await W().getByLabel("Avatar B").selectOption(m.avatars[1]); }
    await snap("paso05-avatares"); await next();
    await W().getByLabel("Ambiente musical").selectOption(m.mood ?? "auto"); if (m.intensity) await W().getByLabel("Intensidad de la música").selectOption(m.intensity);
    await snap("paso06-musica"); await next();
    if (m.mode !== "Solo audio") {
      // Recraft es el proveedor principal del estudio (con precio por imagen) y Pexels ya no se ofrece. Aquí su política de
      // gasto está cerrada (como la dejó la migración): el asistente lo dice ANTES de autorizar y no avanza con él; nunca lo
      // sustituye solo. Con la política lista (caso 13) se ofrece y se estima. Este E2E no sale a fal.ai.
      const rc = await W().getByTestId("proveedor-recraft").textContent();
      ok(`${tag}: Recraft con precio por imagen y, sin política lista, el motivo en pantalla`, /USD 0\.035\/imagen/.test(rc) && /No disponible por ahora: .*no están configurados/.test(rc) && /No se cobra nada/.test(rc), rc.slice(0, 200));
      ok(`${tag}: Recraft preseleccionado como proveedor principal`, await W().getByLabel("Ilustraciones Recraft").isChecked());
      await W().getByRole("button", { name: "Siguiente", exact: true }).click(); await S.p.waitForTimeout(400);
      const blocked = await W().getByRole("alert").textContent().catch(() => "");
      ok(`${tag}: con Recraft no listo el asistente no avanza y explica por qué (no lo cambia solo)`, /Visuales/.test(await stepTitle()) && /No disponible por ahora/.test(blocked ?? "") && await W().getByLabel("Ilustraciones Recraft").isChecked(), String(blocked).slice(0, 160));
      ok(`${tag}: Pexels ya no aparece en el estudio`, (await W().locator('[data-testid="proveedor-pexels"]').count()) === 0);
      await W().getByLabel("Solo estudio y anfitriones (sin imágenes)").check();
    }
    if (m.swap) await W().getByLabel(/Invertir posiciones/).check();
    if (m.format) await W().getByLabel(m.format).check();
    await snap("paso07-visuales");
    const visualOverflow = await S.p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(`${tag}: el paso visuales no desborda el ancho (${vw}px)`, visualOverflow <= 1, `${visualOverflow}px`);
    await next();
    await W().getByTestId("wizard-estimate").locator("table").waitFor();
    const est = await W().getByTestId("wizard-estimate").textContent();
    ok(`${tag}: costo estimado por proveedor ANTES de autorizar`, ["ElevenLabs", "HeyGen", "GitHub Actions", "Total estimado"].every((k) => est.includes(k)) && await W().getByTestId("costo-por-proveedor").isVisible(), est.slice(0, 160));
    if (opts.budgetCheck) {
      // Presupuesto: el tope de USD 50 por episodio se respeta en el asistente (no al final con un 402).
      await W().getByLabel("Presupuesto máximo").fill("60"); await next();
      const alert = await W().getByRole("alert").textContent().catch(() => "");
      ok(`${tag}: presupuesto de USD 60 bloquea el avance con el motivo (tope USD 50)`, /Paso 8/.test(await stepTitle()) && /no puede autorizar más de USD 50/.test(alert ?? ""), String(alert).slice(0, 120));
      await W().getByLabel("Presupuesto máximo").fill("10");
    }
    await snap("paso08-presupuesto"); await next();
    await W().getByTestId("wizard-preview").waitFor(); await W().getByTestId("preview-turnos").waitFor();
    if (m.count === 2 && m.avatars) {
      const tl = await W().getByTestId("preview-timeline").textContent(), cov = await W().getByTestId("cobertura-planos").textContent();
      ok(`${tag}: vista previa con plano general y primeros planos, labios solo de quien habla`, /✔ plano general/.test(cov) && /labios A: habla · B: reposo|labios A: reposo · B: habla/.test(tl) && !/labios A: habla · B: habla/.test(tl), cov);
    }
    await snap("paso09-vista-previa"); await next();
    await W().getByRole("button", { name: "Generar episodio" }).isDisabled().then((d) => ok(`${tag}: sin autorización explícita no se puede generar`, d));
    await W().getByLabel("Autorizo el cargo").check(); await snap("paso10a-autorizar");
    await W().getByRole("button", { name: "Generar episodio" }).click();
    await W().getByTestId("wizard-progress").waitFor(); await snap("paso10b-progreso");
    let row0; for (let i = 0; i < 40; i++) { row0 = (await db.query("select * from podcast_studio_episodes where user_id=$1 and title=$2 order by created_at desc limit 1", [OWNER.id, m.title])).rows[0]; if (row0?.status === "authorized") break; await S.p.waitForTimeout(500); }
    ok(`${tag}: episodio autorizado y trabajo despachado`, row0?.status === "authorized" && fs.readFileSync(path.join(E2E, "logs/dispatch.jsonl"), "utf8").slice(disp0).includes(row0.id), row0?.status);
    // Recuperación: recargar a mitad de la generación vuelve al paso Generación con el mismo episodio.
    await S.p.reload(); await S.p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor(); await W().getByTestId("wizard-progress").waitFor({ timeout: 20000 }).catch(() => {}); ok(`${tag}: recarga durante la generación conserva el episodio y el paso`, /Paso 10/.test(await stepTitle()) && await W().getByTestId("wizard-progress").isVisible());
    if (opts.failTtsCall) {
      // Fallo a mitad (ElevenLabs simulado rechaza la voz N, sin cargo) → episodio fallido; «Reintentar» en la interfaz;
      // el reintento reutiliza lo ya pagado y no cobra dos veces (cada clave del libro liquidada una sola vez).
      const w1 = await worker(row0.id, "studio", { PODCAST_V3_MOCK_TTS_REJECT_CALL: String(opts.failTtsCall) });
      const f = (await db.query("select status, error from podcast_studio_episodes where id=$1", [row0.id])).rows[0];
      ok(`${tag}: rechazo del proveedor a mitad → episodio «failed» con el motivo`, w1.code !== 0 && f.status === "failed" && /429/.test(f.error ?? ""), `${f.status} ${String(f.error).slice(0, 80)}`);
      const o1 = (await db.query("select op, state, count(*)::int n, coalesce(sum(actual_usd),0)::float usd from podcast_studio_operations where episode_id=$1 group by 1,2 order by 1,2", [row0.id])).rows;
      const settled1 = o1.filter((o) => o.op === "tts" && o.state === "settled").reduce((a, o) => a + o.n, 0), released1 = o1.filter((o) => o.state === "released");
      ok(`${tag}: lo pagado antes del fallo queda liquidado (${opts.failTtsCall - 1}) y el rechazo liberado sin cargo`, settled1 === opts.failTtsCall - 1 && released1.length === 1 && released1[0].usd === 0 && !o1.some((o) => o.state === "uncertain" || o.state === "reserved"), JSON.stringify(o1));
      await S.p.reload(); await S.p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor();
      const retry = W().getByRole("button", { name: /Reintentar/ }); await retry.waitFor({ timeout: 30000 }); await snap("paso10f-fallo");
      ok(`${tag}: la interfaz muestra el fallo y ofrece «Reintentar» sin cobrar dos veces`, await retry.isVisible() && /no se cobra dos veces/.test(await retry.textContent()));
      await retry.click();
      await W().getByLabel("Autorizo el cargo").check(); await W().getByRole("button", { name: "Generar episodio" }).click(); await W().getByTestId("wizard-progress").waitFor();
      let r2; for (let i = 0; i < 40; i++) { r2 = (await db.query("select id, status from podcast_studio_episodes where id=$1", [row0.id])).rows[0]; if (r2?.status === "authorized") break; await S.p.waitForTimeout(250); }
      ok(`${tag}: el reintento vuelve a autorizar el MISMO episodio (no crea otro)`, r2?.status === "authorized" && (await db.query("select count(*)::int n from podcast_studio_episodes where user_id=$1 and title=$2", [OWNER.id, m.title])).rows[0].n === 1, r2?.status);
    }
    // Avance real (incidente ec30c594): mientras el worker trabaja, la BASE recibe el avance (antes un `void` sobre la
    // consulta perezosa no enviaba nada) y la PÁGINA lo muestra; nunca retrocede ni marca 100 % antes de «ready».
    const samples = [], uiPcts = []; let sampling = true;
    const sampler = (async () => { while (sampling) {
      const r = (await db.query("select status, progress from podcast_studio_episodes where id=$1", [row0.id]).catch(() => ({ rows: [] }))).rows[0];
      if (r?.status === "generating" && r.progress) samples.push(r.progress);
      const t = await W().getByTestId("atom-progress-pct").first().textContent({ timeout: 500 }).catch(() => null);
      const st = await W().getByTestId("atom-progress").first().getAttribute("data-state", { timeout: 500 }).catch(() => null);
      if (t && st) uiPcts.push([st, Number(t.replace("%", ""))]);
      await new Promise((x) => setTimeout(x, 250));
    } })();
    const w = await worker(row0.id, "studio");
    sampling = false; await sampler;
    const row = (await db.query("select * from podcast_studio_episodes where id=$1", [row0.id])).rows[0];
    if (!opts.failTtsCall) {
      const pcts = samples.map((x) => x.pct), mono = pcts.every((v, i) => i === 0 || v >= pcts[i - 1]);
      ok(`${tag}: el avance llega a la base durante la generación (${samples.length} lecturas, etapas ${[...new Set(samples.map((x) => x.stage))].join("→")})`, samples.length >= 2 && new Set(samples.map((x) => x.stage)).size >= 2, JSON.stringify(pcts.slice(0, 12)));
      ok(`${tag}: el avance guardado nunca retrocede ni llega a 100 % antes de «ready»`, mono && pcts.every((v) => v <= 99), JSON.stringify(pcts.slice(-12)));
      const st = row.progress?.stages ?? {};
      ok(`${tag}: hitos durables por etapa en el episodio terminado (voces ${st.voces?.done}/${st.voces?.total})`, row.status === "ready" && st.voces?.total > 0 && st.voces.done === st.voces.total && (row.progress.activity ?? []).some((a) => a.text === "Archivo final guardado"), JSON.stringify(Object.keys(st)));
      const live = uiPcts.filter(([s]) => s !== "listo").map(([, v]) => v), uiMono = live.every((v, i) => i === 0 || v >= live[i - 1]);
      ok(`${tag}: la página muestra el avance sin retroceder y el 100 % solo con «listo» (${uiPcts.length} lecturas)`, uiPcts.length > 0 && uiMono && live.every((v) => v < 100) && uiPcts.filter(([s]) => s === "listo").every(([, v]) => v === 100), JSON.stringify(uiPcts.slice(-10)));
    }
    ok(`${tag}: el costo liquidado no supera lo autorizado`, Number(row.cost_usd) <= Number(row.authorized_usd) + 1e-6, `${row.cost_usd} / ${row.authorized_usd}`);
    if (opts.failTtsCall) {
      const dup = (await db.query("select key from podcast_studio_operations where episode_id=$1 group by key having count(*) > 1", [row0.id])).rows;
      const ready = /STUDIO_READY (\{.*\})/.exec(w.out); const reused = ready ? Number(JSON.parse(ready[1]).reused) : -1;
      ok(`${tag}: tras el reintento cada clave del libro existe una vez y lo pagado antes se reutilizó (${reused} reutilizadas)`, dup.length === 0 && reused >= opts.failTtsCall - 1, `dup=${dup.length} reused=${reused}`);
    }
    ok(`${tag}: worker del estudio entrega el episodio (proveedores SIMULADOS)`, w.code === 0 && row.status === "ready" && /STUDIO_PROVIDERS mock/.test(w.out), `${row.status} ${row.error ?? ""}`);
    if ((row.spec?.participants || []).some((p) => p.voice_id === DURO)) ok(`${tag}: el episodio guardado conserva voice_kind clonada (simulado)`, row.spec.participants.every((p) => p.voice_id !== DURO || p.voice_kind === "clonada"), JSON.stringify(row.spec.participants.map((p) => [p.voice_id, p.voice_kind])));
    if (m.avatars) {
      const lips = row.result?.lips ?? [], viol = row.result?.lip_violations ?? ["sin datos"];
      ok(`${tag}: lip-sync — ningún avatar mueve los labios fuera de su turno (segmentos del render)`, lips.length > 0 && viol.length === 0 && !lips.some((x) => x.A === "habla" && x.B === "habla"), `${lips.length} segmentos, ${viol.length} violaciones`);
      if (m.count === 2) ok(`${tag}: render con plano general de los dos y primeros planos individuales`, row.result.coverage?.general && (row.result.coverage?.primerPlanoA || row.result.coverage?.primerPlanoB), JSON.stringify(row.result.coverage));
    }
    if (m.mode === "Solo audio") {
      // Modo A: solo audio — no se genera video (ni MP4 en Storage, ni reproductor de video, ni descarga MP4).
      await W().getByTestId("wizard-audio-player").waitFor({ timeout: 30000 }); await snap("paso10c-reproducir-audio");
      ok(`${tag}: solo audio no genera video (sin MP4 en Storage ni en la página)`, row.video_path === null && await W().getByTestId("wizard-player").count() === 0 && await W().getByTestId("wizard-download-mp4").count() === 0, String(row.video_path));
      const aplay = await W().getByTestId("wizard-audio-player").evaluate(async (a) => { a.muted = true; await a.play().catch(() => {}); await new Promise((r) => setTimeout(r, 2500)); const o = { rs: a.readyState, t: a.currentTime, err: a.error?.code ?? null }; a.pause(); return o; });
      ok(`${tag}: el reproductor de audio reproduce el episodio`, aplay.rs >= 2 && aplay.t > 1 && !aplay.err, JSON.stringify(aplay));
      const audUrl = await W().getByTestId("wizard-download-audio").getAttribute("href"), aud = path.join(OUT, `${tag}.mp3`);
      fs.writeFileSync(aud, Buffer.from(await (await fetch(audUrl)).arrayBuffer()));
      const pa = probe(aud), LA = loud(aud);
      ok(`${tag}: descarga de audio MP3, −16±1 LUFS, TP ≤ −1 dBTP`, pa.streams.some((x) => x.codec_name === "mp3") && !pa.streams.some((x) => x.codec_type === "video") && Math.abs(LA.I + 16) <= 1 && LA.TP <= -1, JSON.stringify(LA));
      await S.p.reload(); await S.p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor(); await S.p.getByTestId("studio-episodes").waitFor();
      await S.p.getByRole("button", { name: "Empezar de nuevo" }).click();
      const audioCard = S.p.getByTestId(`studio-episode-${row.id}`);
      await audioCard.getByTestId("studio-download-audio").waitFor({ timeout: 20000 });
      ok(`${tag}: tras reiniciar el asistente, la cuenta sigue ofreciendo el audio`, await audioCard.getByTestId("studio-audio-player").count() === 1 && await audioCard.getByTestId("studio-download-mp4").count() === 0 && await W().getByTestId("wizard-audio-player").count() === 0);
      const ops = (await db.query("select provider, op, state, count(*)::int n from podcast_studio_operations where episode_id=$1 group by 1,2,3", [row.id])).rows;
      ok(`${tag}: solo voz en el libro (sin avatar ni imágenes de pago), todo liquidado`, ops.length > 0 && ops.every((o) => o.state === "settled" && o.op === "tts"), JSON.stringify(ops));
      summary[tag] = { id: row.id, result: row.result, cost: row.cost_usd };
      return;
    }
    await W().getByTestId("wizard-player").waitFor({ timeout: 30000 }); await snap("paso10c-reproducir");
    const play = await W().getByTestId("wizard-player").evaluate(async (v) => { v.muted = true; await v.play().catch(() => {}); await new Promise((r) => setTimeout(r, 3000)); const o = { rs: v.readyState, t: v.currentTime, w: v.videoWidth, h: v.videoHeight, err: v.error?.code ?? null }; v.pause(); return o; });
    ok(`${tag}: el reproductor reproduce el MP4 ${m.format ? "9:16" : "16:9"}`, play.rs >= 2 && play.t > 1 && !play.err && (m.format ? play.h > play.w : play.w > play.h), JSON.stringify(play));
    const mp4Url = await W().getByTestId("wizard-download-mp4").getAttribute("href"), audUrl = await W().getByTestId("wizard-download-audio").getAttribute("href");
    await snap("paso10d-descargar");
    const mp4 = path.join(OUT, `${tag}.mp4`), aud = path.join(OUT, `${tag}.mp3`);
    fs.writeFileSync(mp4, Buffer.from(await (await fetch(mp4Url)).arrayBuffer())); fs.writeFileSync(aud, Buffer.from(await (await fetch(audUrl)).arrayBuffer()));
    const pr = probe(mp4), pa = probe(aud), L = loud(mp4), LA = loud(aud);
    ok(`${tag}: descarga MP4 H.264+AAC y audio MP3 separados`, pr.streams.some((x) => x.codec_name === "h264") && pr.streams.some((x) => x.codec_name === "aac") && pa.streams.some((x) => x.codec_name === "mp3"));
    ok(`${tag}: audio −16±1 LUFS, TP ≤ −1 dBTP (MP4 y MP3 medidos)`, Math.abs(L.I + 16) <= 1 && L.TP <= -1 && Math.abs(LA.I + 16) <= 1, JSON.stringify({ mp4: L, mp3: LA }));
    ok(`${tag}: música presente en la mezcla`, !!row.result?.music, String(row.result?.music));
    const ops = (await db.query("select provider, op, state, count(*)::int n, sum(actual_usd)::float usd from podcast_studio_operations where episode_id=$1 group by 1,2,3", [row.id])).rows;
    ok(`${tag}: cada operación de pago una vez en el libro, todas liquidadas`, ops.length > 0 && ops.every((o) => o.state === "settled"), JSON.stringify(ops));
    fs.writeFileSync(path.join(OUT, `${tag}-resultado.json`), JSON.stringify({ SIMULADO: true, episodio: row.id, modo: row.mode, resultado: row.result, costo_simulado_usd: row.cost_usd, libro: ops }, null, 1));
    const again = await worker(row.id, "studio");
    ok(`${tag}: re-despacho de un episodio listo no regenera ni cobra`, /STUDIO_NOT_AUTHORIZED/.test(again.out));
    await S.p.reload(); await S.p.getByTestId("studio-episodes").waitFor(); await snap("paso10e-lista");
    ok(`${tag}: aparece en «Tus episodios»`, (await S.p.getByTestId("studio-episodes").textContent()).includes(m.title));
    await S.p.getByRole("button", { name: "Empezar de nuevo" }).click();
    const card = S.p.getByTestId(`studio-episode-${row.id}`);
    await card.getByTestId("studio-download-mp4").waitFor({ timeout: 20000 });
    const listed = await card.getByTestId("studio-player").evaluate(async (v) => { v.muted = true; await v.play().catch(() => {}); await new Promise((r) => setTimeout(r, 3000)); const o = { rs: v.readyState, t: v.currentTime, err: v.error?.code ?? null }; v.pause(); return o; });
    ok(`${tag}: tras reiniciar el asistente, la cuenta reproduce y descarga el MP4`, listed.rs >= 2 && listed.t > 1 && !listed.err && await card.getByTestId("studio-download-audio").count() === 1 && await W().getByTestId("wizard-player").count() === 0, JSON.stringify(listed));
    summary[tag] = { id: row.id, result: row.result, cost: row.cost_usd };
  }
  const AV = [["aaaaaaaa-0000-4000-8000-000000000001", "Avatar Hans (simulado)"], ["aaaaaaaa-0000-4000-8000-000000000002", "Avatar Invitada (simulado)"]];
  if (cases.includes("10") || cases.includes("11")) for (const [id, name] of AV) await db.query("insert into public.avatars (id,user_id,name,provider,provider_avatar_id,status,consent_given) values ($1,$2,$3,'heygen','asset:simulado','ready',true) on conflict (id) do nothing", [id, OWNER.id, name]);
  const MODES = [
    { tag: "c10a", mode: "Solo audio", title: "E2E estudio audio", script: "En 1977 el radiotelescopio Big Ear registró una señal intensa y breve.\n\nEl astrónomo Jerry Ehman escribió Wow en el margen.\n\nLa señal nunca volvió a detectarse.", count: 2, voices: [ANA, LEO], mood: "misterio", intensity: "alta" },
    { tag: "c10d", mode: "Narración con imágenes", title: "E2E estudio narración visual", script: "En 1977 el radiotelescopio Big Ear registró una señal intensa y breve.\n\nEl astrónomo Jerry Ehman escribió Wow en el margen.\n\nLa señal nunca volvió a detectarse.", count: 2, voices: [ANA, LEO], mood: "misterio" },
    { tag: "c10b", mode: "Presentador con avatar", title: "E2E estudio avatar", script: "Hola, hoy te cuento tres datos sobre volcanes.\n\nOlympus Mons está en Marte y es el volcán más alto.\n\nLos volcanes crean islas como Hawái.", count: 1, voices: [DURO], avatars: [AV[0][0]] },
    { tag: "c10c", mode: "Conversación con dos avatares", title: "E2E estudio conversación", topic: "la luna Europa", count: 2, voices: [ANA, LEO], avatars: [AV[0][0], AV[1][0]], format: "Vertical 9:16 (Reels/TikTok)", swap: true },
  ];
  if (cases.includes("10")) for (const m of MODES) await studioFlow(s, m.tag, m);
  if (cases.includes("10")) {
    // Aislamiento del estudio: otra cuenta no puede ver, autorizar ni descargar episodios ajenos (ni su libro).
    const own = (await db.query("select id, status, video_path, authorized_usd from podcast_studio_episodes where user_id=$1 and video_path is not null order by created_at desc limit 1", [OWNER.id])).rows[0];
    if (own) {
      const o = await session(OTHER, "intruso-estudio");
      const r = await o.p.evaluate(async (id) => { const g = await fetch(`/api/podcast/v3/${id}`); const a = await fetch(`/api/podcast/v3/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, authorizedUsd: 1 }) }); return [g.status, a.status, await g.text()]; }, own.id);
      ok("c10-aislamiento: GET y autorizar episodio de estudio ajeno → rechazados sin datos", [403, 404].includes(r[0]) && [403, 404].includes(r[1]) && !r[2].includes(own.video_path), r.slice(0, 2).join(","));
      const after = (await db.query("select status, authorized_usd from podcast_studio_episodes where id=$1", [own.id])).rows[0];
      ok("c10-aislamiento: el episodio ajeno queda intacto", after.status === own.status && String(after.authorized_usd) === String(own.authorized_usd), JSON.stringify(after));
      const tok = await o.p.evaluate(() => { const k = Object.keys(localStorage).find((x) => x.includes("auth-token")); return k ? JSON.parse(localStorage.getItem(k)).access_token : null; }).catch(() => null);
      const st = (await fetch(`http://127.0.0.1:54821/storage/v1/object/videos/${own.video_path}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} })).status;
      ok("c10-aislamiento: MP4 ajeno no descargable sin firma", st >= 400, String(st));
      await o.ctx.close();
    } else ok("c10-aislamiento: hay un episodio de estudio entregado para probar", false);
  }
  if (cases.includes("11")) {
    // Móvil: emulación de iPhone 13 y Pixel 7 (viewport, DPR, UA, táctil) en Chromium; capturas de cada paso.
    const DEV = { "iphone13": { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1" },
      "pixel7": { viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" } };
    for (const [dev, opt] of Object.entries(DEV)) {
      const M = await session(OWNER, `c11-${dev}`, opt);
      await M.p.goto(`${BASE}/dashboard`); await shot(M.p, `c11-${dev}-00-dashboard`);
      const link = M.p.locator('header div.sm\\:hidden a[href="/dashboard/podcast"]');
      ok(`c11-${dev}: menú móvil muestra «Podcast»`, await link.isVisible());
      await link.click(); await M.p.waitForURL(/\/dashboard\/podcast$/);
      const overflow = await M.p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(`c11-${dev}: sin desbordamiento horizontal`, overflow <= 1, `${overflow}px`);
      await studioFlow(M, `c11-${dev}`, { ...MODES.find((x) => x.tag === "c10c"), title: `E2E móvil ${dev}` }); // conversación (por etiqueta, no por posición)
      await M.ctx.close();
    }
    const D = await session(OWNER, "c11-escritorio");
    ok("c11-escritorio: menú de escritorio muestra «Podcast»", await D.p.locator('nav a[href="/dashboard/podcast"]').isVisible()); await shot(D.p, "c11-escritorio-menu"); await D.ctx.close();
    // Samsung 390×844: el mismo flujo del estudio (voz concedida, visuales, reproducción y descarga) en el alto real del teléfono.
    const SAMSUNG = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" };
    const Sm = await session(OWNER, "c11-samsung", SAMSUNG);
    await Sm.p.goto(`${BASE}/dashboard/podcast`);
    const smOverflow = await Sm.p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok("c11-samsung: portada 390×844 sin desbordamiento horizontal", smOverflow <= 1, `${smOverflow}px`);
    await studioFlow(Sm, "c11-samsung", { ...MODES.find((x) => x.tag === "c10d"), title: "E2E samsung 390x844", voices: [DURO, LEO] });
    await Sm.ctx.close();
    const So = await session(OTHER, "c11-samsung-otra", SAMSUNG);
    await So.p.goto(`${BASE}/dashboard/podcast`); await So.p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor();
    await So.p.evaluate(() => localStorage.setItem("atomivid.podcast.asistente.v2", JSON.stringify({ step: 3, modality: "audio", mode: "narracion", count: 1 })));
    await So.p.reload(); await So.p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor();
    const otherVoices = await So.p.locator('select[aria-label="Voz A"] option').evaluateAll((os) => os.map((o) => ({ value: o.value, disabled: o.disabled, text: o.textContent })));
    ok("c11-samsung: otra cuenta no ve el clon concedido al dueño", !otherVoices.some((o) => o.value === DURO || /duro hans/i.test(o.text || "")), JSON.stringify(otherVoices.map((o) => o.value)));
    const otherDuro = otherVoices.filter((o) => o.value === "CeFSZuaHs4SxcBxb9nCr");
    ok("c11-samsung: sin concesión, El Duro real sigue «No disponible» para otra cuenta", otherDuro.length > 0 && otherDuro.every((o) => o.disabled && /No disponible/.test(o.text || "")), JSON.stringify(otherDuro));
    const otherApi = await So.p.evaluate(async (v) => {
      const spec = { mode: "narracion", output: "audio", title: "Intruso 390", language: "es", script: "Texto de prueba suficientemente largo para el esquema del estudio.", target_minutes: 1, participants: [{ id: "A", name: "X", voice_id: v, voice_kind: "clonada" }], visual: { provider: "solo_set" }, music: {}, budget_usd: 5 };
      const r = await fetch("/api/podcast/v3", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", spec }) });
      return r.status;
    }, DURO);
    ok("c11-samsung: otra cuenta — la API del estudio rechaza El Duro simulado", otherApi === 400, String(otherApi));
    const otherWidth = await So.p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok("c11-samsung: paso voces de otra cuenta en 390×844 sin desbordamiento", otherWidth <= 1, `${otherWidth}px`);
    await So.ctx.close();
  }
  if (cases.includes("12")) {
    // Presupuesto respetado y fallo + reintento desde la interfaz, en escritorio y en Samsung 390×844.
    await studioFlow(s, "c12", { ...MODES.find((x) => x.tag === "c10d"), title: "E2E reintento escritorio" }, { budgetCheck: true, failTtsCall: 2 });
    const SAMSUNG12 = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" };
    const S12 = await session(OWNER, "c12-samsung", SAMSUNG12);
    await studioFlow(S12, "c12-samsung", { ...MODES.find((x) => x.tag === "c10d"), title: "E2E reintento samsung" }, { budgetCheck: true, failTtsCall: 2 });
    await S12.ctx.close();
  }
  if (cases.includes("13")) {
    // Anfitriones del catálogo + estudios compartidos + Recraft en el asistente REAL (escritorio y Samsung 390×844), sin
    // generar: elegir anfitrión carga su voz y su rostro; vistas previas de los tres estudios; estimación con Recraft.
    // Fotos/recortes del catálogo SINTÉTICOS (sin rostros reales) en el almacenamiento local.
    const CAT = path.join(E2E, "storage/videos/podcast-catalog/hosts");
    for (const [id, c] of [["valeria", "0x8a6a5a"], ["ximena", "0x9a8a6a"], ["victor", "0x5a6a8a"]]) {
      fs.mkdirSync(path.join(CAT, id), { recursive: true });
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${c}:s=640x480`, "-frames:v", "1", path.join(CAT, id, "foto.jpg")]);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${c}@1.0:s=400x380,format=rgba`, "-frames:v", "1", path.join(CAT, id, "recorte.png")]);
    }
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=330:d=2", "-c:a", "libmp3lame", "-b:a", "64k", path.join(CAT, "valeria", "muestra.mp3")]);
    const SAMSUNG13 = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" };
    const SCRIPT = ["Valeria Montclair: Bienvenidos. Hoy hablamos de los sumerios y de la escritura cuneiforme.",
      "Víctor Albarrán: Gracias, Valeria. Son de los textos escritos más antiguos que conocemos.",
      "Valeria Montclair: ¿Qué contaban esas tablillas?", "Víctor Albarrán: Sobre todo cuentas, contratos y leyes.",
      "Valeria Montclair: Gracias, Víctor. Nos escuchamos pronto."].join("\n");
    // Política de Recraft lista en la base desechable (activada, topes 10/50, línea base); el saldo se lee al arrancar.
    await db.query("update pi_supply_policies set enabled=true, baseline=1, unit_cost_usd=1, daily_cap_usd=10, monthly_cap_usd=50, max_concurrent=1, max_daily_calls=250 where provider='recraft'");
    for (const [dev, opt] of [["escritorio", { viewport: { width: 1440, height: 900 } }], ["samsung", SAMSUNG13]]) {
      const t = `c13-${dev}`, S = await session(OWNER, t, opt);
      const W = () => S.p.getByTestId("podcast-wizard"), next = async () => { await W().getByRole("button", { name: "Siguiente" }).click(); await S.p.waitForTimeout(400); };
      const title = async () => (await W().getByTestId("wizard-step-title").textContent()) ?? "";
      const wide = async (n) => { const o = await S.p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); ok(`${t}: ${n} sin desbordamiento horizontal`, o <= 1, `${o}px`); };
      await S.p.goto(`${BASE}/dashboard/podcast`); await S.p.evaluate(() => localStorage.removeItem("atomivid.podcast.asistente.v2")); await S.p.reload();
      await S.p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor();
      await W().getByTestId("modalidad-dialogo").click(); await next();
      await W().getByLabel("Título del episodio").fill(`E2E catálogo ${dev}`); await W().getByLabel("Tema", { exact: true }).fill("Los sumerios y la escritura cuneiforme");
      await W().getByLabel("Guion").fill(SCRIPT); await next();
      ok(`${t}: paso Participantes`, /Participantes/.test(await title()), await title());
      const A = W().getByRole("radiogroup", { name: /Participante A/ }), B = W().getByRole("radiogroup", { name: /Participante B/ });
      ok(`${t}: catálogo con 3 anfitriones (foto, nombre, descripción)`, (await A.locator('[data-testid^="anfitrion-"]').count()) === 3 && /Valeria Montclair/.test(await A.textContent()) && /Víctor Albarrán/.test(await A.textContent()));
      const imgs = await A.locator("img").evaluateAll((els) => els.map((e) => e.complete && e.naturalWidth > 0));
      ok(`${t}: fotos de los anfitriones cargan (enlaces firmados)`, imgs.length === 3 && imgs.every(Boolean), JSON.stringify(imgs));
      ok(`${t}: muestra de voz de Valeria`, (await A.getByTestId("anfitrion-valeria").locator("audio").count()) === 1);
      ok(`${t}: Víctor se presenta como personaje virtual (sin credenciales)`, /personaje virtual/i.test(await A.getByTestId("anfitrion-victor").textContent()));
      await A.getByTestId("anfitrion-valeria").getByRole("radio").click();
      ok(`${t}: Valeria no se puede elegir dos veces`, await B.getByTestId("anfitrion-valeria").getByRole("radio").isDisabled());
      await B.getByTestId("anfitrion-victor").getByRole("radio").click();
      await shot(S.p, `${t}-01-anfitriones`); await wide("anfitriones");
      await next();
      ok(`${t}: paso Voces`, /Voces/.test(await title()), await title());
      const voces = await W().locator('[data-testid^="voz-incluida-"]').allTextContents();
      ok(`${t}: voz cargada automáticamente con el anfitrión (Callie para Valeria), sin selector`, voces.length === 2 && /Callie/.test(voces[0]) && (await W().locator('select[aria-label^="Voz "]').count()) === 0, JSON.stringify(voces));
      await shot(S.p, `${t}-02-voces`); await next();
      ok(`${t}: avatares del catálogo incluidos`, (await W().locator('[data-testid^="avatar-incluido-"]').count()) === 2);
      await next(); await next();
      ok(`${t}: paso Visuales`, /Visuales/.test(await title()), await title());
      ok(`${t}: Recraft preseleccionado y Pexels ausente`, await W().getByLabel("Ilustraciones Recraft").isChecked() && (await W().locator('[data-testid="proveedor-pexels"]').count()) === 0);
      const rc13 = await W().getByTestId("proveedor-recraft").textContent();
      ok(`${t}: con la política lista, Recraft se ofrece sin aviso de bloqueo`, !/No disponible/.test(rc13), rc13.slice(0, 160));
      for (const st of ["moderno", "calido", "minimalista"]) {
        await W().getByTestId(`estudio-${st}`).click(); await S.p.waitForTimeout(500);
        // La tarjeta del estudio lleva su miniatura y debajo va la vista previa grande del elegido: se mira la grande.
        const pv = W().getByTestId(`studio-preview-${st}`).last();
        const ld = await pv.locator("img").evaluateAll((els) => els.map((e) => e.complete && e.naturalWidth > 0));
        ok(`${t}: vista previa del estudio ${st} (estudio + 2 anfitriones + mesa)`, ld.length >= 4 && ld.every(Boolean), JSON.stringify(ld));
        await pv.screenshot({ path: path.join(OUT, `${t}-03-estudio-${st}.png`) });
      }
      await shot(S.p, `${t}-03-visuales`); await wide("visuales");
      await next();
      await W().getByTestId("wizard-estimate").locator("table").waitFor();
      const est = await W().getByTestId("wizard-estimate").textContent();
      ok(`${t}: la estimación incluye Recraft (ilustraciones) antes de autorizar`, /Recraft/.test(est) && /ElevenLabs/.test(est) && /HeyGen/.test(est), est.slice(0, 200));
      await shot(S.p, `${t}-04-presupuesto`); await wide("presupuesto");
      await S.p.evaluate(() => localStorage.removeItem("atomivid.podcast.asistente.v2"));
      await S.ctx.close();
    }
    await db.query("update pi_supply_policies set enabled=false where provider='recraft'");
  }
  if (cases.includes("15")) {
    // Episodio real ec30c594 (2026-10-29): el job murió instalando el entorno, ANTES de tomar el episodio. mark-failed solo
    // cerraba «generating» → el episodio quedó «authorized» en 0 % sin explicación. Ahora se explica y sigue autorizado.
    const ins = (id, status, startedSql) => db.query(`insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,authorized_usd,authorized_at,run_started_at) values ($1,$2,'c15','narracion','{"version":"podcast-studio/3"}',$3,2,now(),${startedSql})`, [id, OWNER.id, status]);
    const A = "c15a0000-0000-4000-8000-000000000001", G = "c15a0000-0000-4000-8000-000000000002", S = "c15a0000-0000-4000-8000-000000000003";
    await ins(A, "authorized", "null"); await ins(G, "generating", "now()"); await ins(S, "authorized", "now() + interval '1 minute'");
    await db.query("insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values ('980a9fbda02b3e68f906ae9865bebde0842172b730db77b9486fe18d2474ac03',$1,$2,'elevenlabs','tts','reserved',0.01)", [OWNER.id, G]);
    const row = async (id) => (await db.query("select status,error,authorized_usd,authorized_at from public.podcast_studio_episodes where id=$1", [id])).rows[0];
    const before = await row(A);
    const ra = await markFailed(A, "studio");
    const a = await row(A);
    ok("c15: sin arrancar → sigue «authorized» con su autorización intacta", a.status === "authorized" && Number(a.authorized_usd) === 2 && +a.authorized_at === +before.authorized_at, JSON.stringify(a));
    ok("c15: sin arrancar → el error explica que no se cobró y cómo reintentar", /No se pudo iniciar/.test(a.error ?? "") && /no se cobra otra vez/.test(a.error ?? "") && /STUDIO_NOT_STARTED_NOTED 1/.test(ra.out), `${a.error} | ${ra.out.slice(-160)}`);
    await markFailed(G, "studio");
    const g = await row(G), op = (await db.query("select state from public.podcast_studio_operations where key='980a9fbda02b3e68f906ae9865bebde0842172b730db77b9486fe18d2474ac03'")).rows[0];
    ok("c15: muerto durante la generación → «failed» y lo reservado pasa a «uncertain» (como antes)", g.status === "failed" && op.state === "uncertain", `${g.status} ${op.state}`);
    await markFailed(S, "studio");
    ok("c15: ya tomado por un worker tras esta autorización → no se toca", (await row(S)).error === null);
    // La API ofrece volver a pedir el inicio sin cobrar: el episodio sigue autorizado y no hay operación nueva.
    const ops = Number((await db.query("select count(*)::int n from public.podcast_studio_operations where episode_id=$1", [A])).rows[0].n);
    ok("c15: ningún cargo ni reserva para el episodio que no arrancó", ops === 0, String(ops));
    await db.query("delete from public.podcast_studio_operations where key='980a9fbda02b3e68f906ae9865bebde0842172b730db77b9486fe18d2474ac03'");
    await db.query("delete from public.podcast_studio_episodes where id = any($1)", [[A, G, S]]);
  }
  await s.ctx.close(); await browser.close(); await db.end();
  // Sin omisiones silenciosas: cada caso pedido debe haber ejecutado comprobaciones (mínimos por caso).
  const MIN = { 1: 4, 2: 7, 3: 3, 4: 4, 5: 5, 6: 6, 7: 16, 8: 13, 9: 10, 10: 45, 11: 40, 12: 40, 13: 34, 15: 5 };
  const perCase = Object.fromEntries(cases.map((c) => [c, results.filter((r) => r.name.startsWith(`c${c}:`) || r.name.startsWith(`c${c}-`) || (c === "10" && /^c10[a-d]:/.test(r.name)) || (c === "11" && /^c11-/.test(r.name)) || (c === "12" && /^c12-/.test(r.name))).length]));
  for (const c of cases) if ((perCase[c] ?? 0) < (MIN[c] ?? 1)) results.push({ name: `c${c}: ejecutó al menos ${MIN[c]} comprobaciones`, pass: false, detail: `solo ${perCase[c] ?? 0}` });
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ results, summary, perCase, cases }, null, 1));
  for (const r of results.filter((x) => !x.pass)) console.log(`FALLO_DETALLE FAIL ${r.name} ${String(r.detail).slice(0, 200)}`);
  const failed = results.filter((r) => !r.pass).length; console.log(`POR_CASO ${JSON.stringify(perCase)}`); console.log(`RESULTADO ${results.length - failed}/${results.length} PASS`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
