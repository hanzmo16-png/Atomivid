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
  const env = { ...process.env, ...Object.fromEntries(fs.readFileSync(path.join(E2E, "secrets/podcast-worker.env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])), EPISODE_ID: id, JOB_KIND: kind };
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
  const cases = (process.argv[2] ?? "1,2,3,4,5,6").split(",");
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
      const envw = { ...process.env, ...Object.fromEntries(fs.readFileSync(path.join(E2E, "secrets/podcast-worker.env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])), EPISODE_ID: id2, JOB_KIND: "narration" };
      const w = spawn("npx", ["tsx", "scripts/podcast-video-worker.ts"], { cwd: REPO, env: envw, detached: true });
      while (ttsCalls().length - m0 < 10) await new Promise((r) => setTimeout(r, 300));
      process.kill(-w.pid, "SIGKILL"); await new Promise((r) => setTimeout(r, 1500));
      const killedAt = ttsCalls().length - m0;
      await db.query("update podcast_episodes set run_started_at = now() - interval '1 hour' where id=$1", [id2]); // simula función muerta (stale)
      const r2 = await worker(id2, "narration"); const after = await ep(id2); const total = ttsCalls().length - m0; const turns = after.production.turns.length;
      // Diseño: la llamada que estaba en vuelo al matar el proceso es ambigua (pudo cobrarse). NO se reenvía; el episodio queda en revisión con mensaje claro.
      ok("c4: worker matado → reanudación no reenvía la llamada ambigua (0 cobros dobles)", total === killedAt && after.status === "failed" && /incierto/i.test(after.error ?? ""), `llamadas=${total} matado tras ${killedAt} estado=${after.status} «${after.error}»`);
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
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ results, summary }, null, 1));
  await s.ctx.close(); await browser.close(); await db.end();
  const failed = results.filter((r) => !r.pass).length; console.log(`RESULTADO ${results.length - failed}/${results.length} PASS`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
