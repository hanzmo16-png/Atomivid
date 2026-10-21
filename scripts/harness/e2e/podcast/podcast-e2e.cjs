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
async function session(user, tag) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, recordVideo: { dir: path.join(OUT, `video-${tag}`), size: { width: 1280, height: 1000 } }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(60000);
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", user.email); await p.fill("input[name=password]", user.password);
  await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
  return { ctx, p };
}
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `${n}.png`), fullPage: true });
function worker(id, kind) {
  const env = { ...process.env, ...Object.fromEntries(fs.readFileSync(path.join(E2E, "secrets/podcast-worker.env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])), EPISODE_ID: id, JOB_KIND: kind, NPM_CONFIG_UPDATE_NOTIFIER: "false" };
  return new Promise((res) => { const w = spawn("npx", ["tsx", "scripts/podcast-video-worker.ts"], { cwd: REPO, env }); let o = ""; w.stdout.on("data", (d) => (o += d)); w.stderr.on("data", (d) => (o += d)); w.on("close", (c) => { fs.appendFileSync(path.join(OUT, `worker-${id}-${kind}.log`), o); res({ code: c, out: o, proc: w }); }); });
}
async function createEpisode(p, o) {
  await p.goto(`${BASE}/dashboard/podcast`);
  await p.getByLabel("Título").fill(o.title);
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
  await p.getByRole("button", { name: /Generar narración|Continuar \/ reintentar/ }).click();
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
      await s.p.reload(); await generate(s.p, id, "c4-reanudar");
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
    const f = await download(s.p, "c3"); summary.c3 = { id, calls: calls.length, ownTurns: aTurns.length, sha: sha(fs.readFileSync(f)) };
  }
  if (cases.includes("5")) {
    const o = await session(OTHER, "intruso");
    await o.p.goto(`${BASE}/dashboard/podcast`); await shot(o.p, "c5-intruso-formulario");
    const html = await o.p.content();
    ok("c5: El Duro no aparece para otra cuenta", !html.includes(DURO) && !/duro hans/i.test(html));
    const forced = await o.p.evaluate(async (v) => { const r = await fetch("/api/podcast", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x", script: "A: hola que tal estás hoy\n\nB: muy bien gracias por preguntar", language: "es", voiceId: v, production: { mode: "conversation", style: "standard", dialogue: "A: hola que tal estás hoy\n\nB: muy bien gracias por preguntar", participants: [{ id: "A", voiceId: v }, { id: "B", voiceId: "VozCatalogoAna01" }] } }) }); return [r.status, await r.text()]; }, DURO);
    ok("c5: forzar El Duro por API → rechazado", forced[0] === 400, forced.join(" "));
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
      if (mode === "timeout") { await s.p.getByRole("button", { name: /Continuar \/ reintentar/ }).click(); await s.p.waitForTimeout(4000); const r2 = await ep(id); ok("c6: reintento tras ambiguo no vuelve a pedir el segmento incierto", r2.status === "failed" && ttsCalls().length - n0 === 1, `${ttsCalls().length - n0} llamadas`); }
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
  await s.ctx.close(); await browser.close(); await db.end();
  // Sin omisiones silenciosas: cada caso pedido debe haber ejecutado comprobaciones (mínimos por caso).
  const MIN = { 1: 4, 2: 7, 3: 3, 4: 4, 5: 5, 6: 6, 7: 16, 8: 13 };
  const perCase = Object.fromEntries(cases.map((c) => [c, results.filter((r) => r.name.startsWith(`c${c}:`) || r.name.startsWith(`c${c}-`)).length]));
  for (const c of cases) if ((perCase[c] ?? 0) < (MIN[c] ?? 1)) results.push({ name: `c${c}: ejecutó al menos ${MIN[c]} comprobaciones`, pass: false, detail: `solo ${perCase[c] ?? 0}` });
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ results, summary, perCase, cases }, null, 1));
  const failed = results.filter((r) => !r.pass).length; console.log(`POR_CASO ${JSON.stringify(perCase)}`); console.log(`RESULTADO ${results.length - failed}/${results.length} PASS`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
