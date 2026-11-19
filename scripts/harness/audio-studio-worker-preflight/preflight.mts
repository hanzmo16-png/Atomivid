/**
 * Preflight GRATUITO del worker de producción de Audio Podcast Studio (T-20261119-0918-chatgpt-25).
 *
 * Ejecuta el CLI REAL que corre `.github/workflows/audio-studio-worker.yml` (`scripts/audio-studio/worker.ts`) contra:
 *  - un Supabase Storage DESECHABLE en 127.0.0.1 (fake-storage.mjs), con el mismo cliente supabase-js de producción;
 *  - la voz de demostración espeak-ng (USD 0) y FFmpeg locales;
 *  - un cortafuegos de proceso (net-guard.mjs) que bloquea y anota cualquier conexión que no sea a 127.0.0.1.
 * No usa ElevenLabs, OpenAI ni Anthropic, ni secretos, ni Supabase real. NO prueba producción autenticada: eso sigue
 * siendo la prueba de 10 minutos de Hans (docs/AUDIO-STUDIO-WORKER-PREFLIGHT.md).
 *
 * Uso: npx tsx scripts/harness/audio-studio-worker-preflight/preflight.mts [--out DIR] [--control-negativo[=voz|red|mp3]]
 *  Controles negativos (cada uno DEBE salir con 1 y fallar exactamente en su comprobación):
 *   voz → AUDIO_STUDIO_VOICE=off en el caso A (falla A1);
 *   red → el worker intenta salir a internet (red-canary.mjs): el cortafuegos debe bloquearlo y N1 fallar;
 *   mp3 → el MP3 publicado de A desaparece del Storage: A2 debe fallar (nunca aprobar un MP3 ausente).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AUDIO_STUDIO_BUCKET, AUDIO_STUDIO_PREFIX, storageStore } from "../../../src/lib/audio-studio/store";
import { createProject, getProject, listProjects, requestGeneration, requestRemix, resumeGeneration, saveProject, setArchived, type Deps } from "../../../src/lib/audio-studio/service";
import { voiceAvailability } from "../../../src/lib/audio-studio/voice";
import { modelRate, type AudioProject } from "../../../src/lib/audio-studio/model";
import { AUDIO_STUDIO_DISPATCH_EVENT, dispatchPayload, startWorker } from "../../../src/lib/audio-studio/worker";
import { startFakeStorage } from "./fake-storage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const args = process.argv.slice(2);
const OUT = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(tmpdir(), "audio-studio-worker-preflight"));
const negArg = args.find((a) => a === "--control-negativo" || a.startsWith("--control-negativo="));
const NEGATIVE: "voz" | "red" | "mp3" | null = negArg ? ((negArg.split("=")[1] || "voz") as "voz" | "red" | "mp3") : null;
if (NEGATIVE && !["voz", "red", "mp3"].includes(NEGATIVE)) throw new Error(`control negativo desconocido: ${NEGATIVE}`);
mkdirSync(path.join(OUT, "mp3"), { recursive: true });

const OWNER = "0f0f0f0f-1111-4111-8111-000000000001"; // hace de INTERNAL_PRODUCTION_OWNER_USER_ID
const OTHER = "0f0f0f0f-2222-4222-8222-000000000002"; // cuenta ajena
type Row = { id: string; requisito: string; estado: "PASS" | "FAIL" | "BLOCKED" | "NO_PROBADO"; detalle: string };
const rows: Row[] = [];
const check = (id: string, requisito: string, ok: boolean, detalle: Record<string, unknown> | string = "") => {
  const d = typeof detalle === "string" ? detalle : JSON.stringify(detalle);
  rows.push({ id, requisito, estado: ok ? "PASS" : "FAIL", detalle: d });
  console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${requisito}  ${d.slice(0, 220)}`);
};
const note = (id: string, requisito: string, estado: Row["estado"], detalle: string) => { rows.push({ id, requisito, estado, detalle }); console.log(`${estado}  [${id}] ${requisito}  ${detalle}`); };

// ---------- Guiones de prueba (≥ 450 palabras: ~3,2 min de voz, dentro de la tolerancia del objetivo de 5 min) ----------
const ES = ["La calma no es la ausencia de problemas, sino la forma en que decidimos mirarlos cada mañana.", "Cuando respiramos despacio, el cuerpo entiende que no hay peligro inmediato y la mente se ordena.", "Hoy hablamos de pequeños hábitos que cualquiera puede practicar sin gastar dinero ni tiempo extra.", "Escribir tres líneas al despertar ayuda a separar lo urgente de lo importante con más claridad.", "Caminar diez minutos después de comer mejora el ánimo y también la concentración de la tarde."];
const EN = ["Calm is not the absence of problems, it is the way we decide to look at them every morning.", "When we breathe slowly, the body understands there is no immediate danger and the mind settles.", "Today we talk about small habits anyone can practice without spending money or extra time.", "Writing three lines after waking up helps separate what is urgent from what is truly important.", "Walking for ten minutes after lunch lifts the mood and improves focus during the afternoon."];
function script(lang: "es" | "en", voices: 1 | 2): string {
  const lines = lang === "es" ? ES : EN, secs = lang === "es" ? ["Apertura", "Idea central", "Cierre"] : ["Opening", "Main idea", "Closing"];
  const tag = (k: number) => (voices === 2 ? (lang === "es" ? `Voz ${(k % 2) + 1}: ` : `Voice ${(k % 2) + 1}: `) : "");
  let k = 0;
  // Cada intervención es única (lleva su número): así «segmentos» = llamadas reales al motor de voz. Las repeticiones
  // exactas se sintetizarían una sola vez (caché por contenido), que es el comportamiento correcto pero no lo que se mide aquí.
  const n = (i: number) => (lang === "es" ? ` Apunte ${i + 1}.` : ` Note ${i + 1}.`);
  return secs.map((h) => `## ${h}\n\n` + Array.from({ length: 6 }, () => { const i = k++; return `${tag(i)}${lines[i % lines.length]} ${lines[(i + 2) % lines.length]}${n(i)}`; }).join("\n\n")).join("\n\n");
}

// ---------- Infraestructura desechable ----------
const storage = await startFakeStorage({ bucket: AUDIO_STUDIO_BUCKET });
const supabase = createClient(storage.url, storage.key, { auth: { persistSession: false, autoRefreshToken: false } });
const store = storageStore(supabase.storage.from(AUDIO_STUDIO_BUCKET) as never);
const demoEnv = { AUDIO_STUDIO_VOICE: "demo" } as Record<string, string>;
const voice = voiceAvailability(demoEnv, (m) => modelRate(m).rate, { owner: true });
const deps: Deps = { store, env: demoEnv, voice };
const NET_LOG = path.join(OUT, "red-bloqueada.ndjson");
writeFileSync(NET_LOG, "");
const MUSIC = mkdtempSync(path.join(tmpdir(), "aps-preflight-music-"));
const FAKEBIN = mkdtempSync(path.join(tmpdir(), "aps-preflight-bin-"));
const COUNT = path.join(FAKEBIN, "espeak-calls");
symlinkSync(path.join(HERE, "fake-espeak.sh"), path.join(FAKEBIN, "espeak-ng"));
const REAL_ESPEAK = execFileSync("bash", ["-lc", "command -v espeak-ng"]).toString().trim();
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const espeakCalls = () => (existsSync(COUNT) ? Number(readFileSync(COUNT, "utf8").trim() || 0) : 0);

/**
 * Corre el CLI REAL del worker como lo hace el workflow (mismos nombres de variables). Asíncrono: el Storage desechable
 * vive en este mismo proceso y debe poder responder mientras el worker trabaja.
 */
async function worker(owner: string, project: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: `${FAKEBIN}:${process.env.PATH}`, HOME: process.env.HOME ?? "/tmp", TMPDIR: tmpdir(),
    SUPABASE_URL: storage.url, SUPABASE_SERVICE_ROLE_KEY: storage.key,
    AUDIO_STUDIO_VOICE: "demo", INTERNAL_PRODUCTION_OWNER_USER_ID: OWNER, AUDIO_STUDIO_MUSIC_DIR: MUSIC,
    NODE_OPTIONS: `--import ${path.join(HERE, "net-guard.mjs")}${NEGATIVE === "red" ? ` --import ${path.join(HERE, "red-canary.mjs")}` : ""}`, PREFLIGHT_NET_LOG: NET_LOG,
    PREFLIGHT_ESPEAK_COUNT: COUNT, PREFLIGHT_REAL_ESPEAK: REAL_ESPEAK, ...extra,
  };
  const before = espeakCalls();
  const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(TSX, [path.join(ROOT, "scripts/audio-studio/worker.ts"), owner, project], { cwd: ROOT, env: env as unknown as NodeJS.ProcessEnv });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d)); child.stderr.on("data", (d: Buffer) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
    child.on("close", (c: number | null) => { clearTimeout(timer); resolve({ code: c, out }); });
  });
  writeFileSync(path.join(OUT, `worker-${project.slice(-4)}-${Date.now()}.log`), out);
  const resultado = (out.match(/^RESULTADO .*$/m) ?? [""])[0];
  return { code, resultado, calls: espeakCalls() - before };
}
const ownerObjects = () => [...storage.objects.keys()];
/** Escrituras reales (subidas) recibidas por el Storage desechable: list y sign no cuentan. */
const writes = () => storage.log.filter((l: { method: string; path: string }) => (l.method === "POST" || l.method === "PUT") && l.path.startsWith(`/storage/v1/object/${AUDIO_STUDIO_BUCKET}/`)).length;
function probe(buf: Buffer | null, name: string) {
  if (!buf || buf.length === 0) return null; // MP3 ausente o vacío: la comprobación falla, no se aprueba
  const f = path.join(OUT, "mp3", name);
  writeFileSync(f, buf);
  let p;
  try { p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration,bit_rate", "-of", "json", f]).toString()); } catch { return null; }
  if (!p.streams?.length) return null;
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", f, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const rms = (a: number, b: number) => { let x = 0, k = 0; for (let i = Math.floor(a * 8000); i < Math.min(s.length, Math.floor(b * 8000)); i++) { x += (s[i] / 32768) ** 2; k++; } return k ? 20 * Math.log10(Math.sqrt(x / k) + 1e-9) : -120; };
  return { codec: p.streams[0].codec_name as string, sampleRate: Number(p.streams[0].sample_rate), duration: Number(p.format.duration), kbps: Math.round(Number(p.format.bit_rate) / 1000), rms };
}

async function newEpisode(lang: "es" | "en", voices: 1 | 2, owner = OWNER) {
  const c = await createProject(deps, owner, { title: `Preflight ${lang.toUpperCase()} ${voices} voz`, voiceCount: voices, language: lang });
  if (!c.ok) throw new Error(`crear: ${c.body.error}`);
  const p = c.body as AudioProject;
  const s = await saveProject(deps, owner, p.id, { revision: p.revision, targetMinutes: 5, script: script(lang, voices), budgetUsd: 2 });
  if (!s.ok) throw new Error(`guardar: ${s.body.error}`);
  return s.body as AudioProject & { estimate: { estimatedUsd: number } };
}
async function enqueue(owner: string, id: string) {
  const cur = (await getProject(deps, owner, id));
  if (!cur.ok) throw new Error("no existe");
  const v = cur.body as AudioProject & { estimate: { estimatedUsd: number } };
  return requestGeneration(deps, owner, id, { revision: v.revision, confirmUsd: v.estimate.estimatedUsd });
}

// ---------- 0. Contrato estático del despacho (el mismo que usa producción) ----------
const wf = readFileSync(path.join(ROOT, ".github/workflows/audio-studio-worker.yml"), "utf8");
check("K1", "el workflow escucha el mismo evento que despacha la API", wf.includes(`types: [${AUDIO_STUDIO_DISPATCH_EVENT}]`), { evento: AUDIO_STUDIO_DISPATCH_EVENT });
check("K2", "el workflow ejecuta el CLI probado aquí con OWNER_ID y PROJECT_ID por entorno", /npx tsx scripts\/audio-studio\/worker\.ts "\$OWNER_ID" "\$PROJECT_ID"/.test(wf));
check("K3", "voz por defecto del workflow = demo (USD 0) y dueño desde variable o secreto existente", wf.includes("AUDIO_STUDIO_VOICE: ${{ vars.AUDIO_STUDIO_VOICE || 'demo' }}") && wf.includes("INTERNAL_PRODUCTION_OWNER_USER_ID: ${{ vars.INTERNAL_PRODUCTION_OWNER_USER_ID || secrets.INTERNAL_PRODUCTION_OWNER_USER_ID }}"));
check("K4", "ffmpeg y espeak-ng se instalan en el runner del worker", /apt-get install -yq ffmpeg espeak-ng/.test(wf));
{
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => { captured = { url, init }; return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
  const mode = await startWorker(store, voice, OWNER, "0f0f0f0f-3333-4333-8333-000000000003", { VERCEL: "1", GH_WORKER_TOKEN: "tok-preflight", GH_WORKER_REPO: "owner/repo" }, fakeFetch);
  const c = captured as { url: string; init: RequestInit } | null;
  const body = c ? JSON.parse(String(c.init.body)) : null;
  check("K5", "API → despacho GitHub: URL, evento y payload solo con ids (sin secretos ni guion)", mode === "github" && c?.url === "https://api.github.com/repos/owner/repo/dispatches"
    && JSON.stringify(body) === JSON.stringify(dispatchPayload(OWNER, "0f0f0f0f-3333-4333-8333-000000000003")) && !String(c?.init.body).includes("tok-preflight"), { mode, url: c?.url, body });
  const off = await startWorker(store, { ok: false, reason: "sin voz" }, OTHER, "0f0f0f0f-3333-4333-8333-000000000003", { VERCEL: "1", GH_WORKER_TOKEN: "t", GH_WORKER_REPO: "o/r" }, fakeFetch);
  check("K6", "cuenta sin voz (cliente) → no se despacha nada", off === "apagado");
}

// ---------- 1. Cuatro episodios reales: ES/EN × 1/2 voces ----------
const cases: { id: string; lang: "es" | "en"; voices: 1 | 2 }[] = [{ id: "A", lang: "es", voices: 1 }, { id: "B", lang: "es", voices: 2 }, { id: "C", lang: "en", voices: 1 }, { id: "D", lang: "en", voices: 2 }];
const done: Record<string, AudioProject> = {};
for (const k of cases) {
  const p = await newEpisode(k.lang, k.voices);
  const q = await enqueue(OWNER, p.id);
  check(`${k.id}0`, `${k.lang.toUpperCase()} ${k.voices} voz: la API acepta la autorización (USD ${p.estimate.estimatedUsd.toFixed(2)}) y encola`, q.ok && q.status === 202, { status: q.status });
  const w = await worker(OWNER, p.id, NEGATIVE === "voz" && k.id === "A" ? { AUDIO_STUDIO_VOICE: "off" } : {});
  const after = (await store.get(OWNER, p.id))!;
  const ok = w.code === 0 && /^RESULTADO TERMINADA \(voz de demostración, USD 0\)$/.test(w.resultado) && after.generation.status === "terminada" && !!after.audio;
  check(`${k.id}1`, `${k.lang.toUpperCase()} ${k.voices} voz: el worker real termina con voz demo USD 0`, ok, { code: w.code, resultado: w.resultado, estado: after.generation.status });
  if (!after.audio) continue;
  done[k.id] = after;
  if (NEGATIVE === "mp3" && k.id === "A") storage.objects.delete(after.audio.path); // control negativo: el MP3 «publicado» no está
  const buf = await store.getBlob(after.audio.path);
  const m = probe(buf, `${k.id}-${k.lang}-${k.voices}voz.mp3`);
  if (!m) { check(`${k.id}2`, `${k.id}: MP3 decodificable (mp3, 48 kHz, ~192 kbps) y duración = la registrada`, false, { mp3: "ausente o no decodificable", ruta: after.audio.path }); continue; }
  check(`${k.id}2`, `${k.id}: MP3 decodificable (mp3, 48 kHz, ~192 kbps) y duración = la registrada`, m.codec === "mp3" && m.sampleRate === 48000 && m.kbps >= 180 && m.kbps <= 200 && Math.abs(m.duration - after.audio.durationSeconds) < 0.25 && m.duration > 150, { ...m, rms: undefined });
  check(`${k.id}3`, `${k.id}: máster −16 LUFS ±1,5 y pico ≤ −1 dBTP`, Math.abs(after.audio.lufs + 16) <= 1.5 && after.audio.truePeak <= -1, { lufs: after.audio.lufs, tp: after.audio.truePeak });
  const intro = m.rms(0.8, 2.5), speech = m.rms(5, 9);
  check(`${k.id}4`, `${k.id}: música CC0 audible en la entrada y voz ≥ 3 dB encima (ducking)`, after.audio.musicTracks.length > 0 && after.audio.musicTracks.every((t) => t.endsWith("CC0 1.0")) && intro > -55 && speech > intro + 3, { pistas: after.audio.musicTracks.length, intro: +intro.toFixed(1), voz: +speech.toFixed(1) });
  check(`${k.id}5`, `${k.id}: gasto 0, proveedor demo y segmentos = llamadas reales a espeak`, after.spentUsd === 0 && after.audio.provider === "demo" && w.calls === after.audio.segments && after.audio.reusedSegments === 0, { spent: after.spentUsd, provider: after.audio.provider, segmentos: after.audio.segments, llamadas: w.calls });
}

// ---------- 2. Idempotencia: despacho duplicado de un episodio terminado ----------
if (done.A) {
  const objs = ownerObjects().length;
  const w = await worker(OWNER, done.A.id);
  check("E1", "despacho duplicado de un episodio terminado → RECHAZADO sin voz, sin escrituras", /RESULTADO RECHAZADO generación en estado «terminada»/.test(w.resultado) && w.calls === 0 && ownerObjects().length === objs, { resultado: w.resultado, llamadas: w.calls });
}

// ---------- 3. Fallo antes de publicar + reanudación sin repetir voz ----------
{
  const p = await newEpisode("es", 1);
  await enqueue(OWNER, p.id);
  const w1 = await worker(OWNER, p.id, { PREFLIGHT_ESPEAK_FAIL_AT: String(espeakCalls() + 3) });
  const f = (await store.get(OWNER, p.id))!;
  const mp3s = ownerObjects().filter((o) => o.startsWith(`${AUDIO_STUDIO_PREFIX}/${OWNER}/${p.id}/audio/`));
  const cached = ownerObjects().filter((o) => o.startsWith(`${AUDIO_STUDIO_PREFIX}/${OWNER}/${p.id}/tts/`)).length;
  check("F1", "fallo del motor de voz a mitad → «fallida», código 1, SIN MP3 publicado", w1.code === 1 && /RESULTADO FALLIDA/.test(w1.resultado) && f.generation.status === "fallida" && !f.audio && mp3s.length === 0, { code: w1.code, estado: f.generation.status, error: f.generation.error, voz_en_cache: cached });
  const r = await resumeGeneration(deps, OWNER, p.id);
  const w2 = await worker(OWNER, p.id);
  const t = (await store.get(OWNER, p.id))!;
  check("F2", "«Reanudar» con la misma autorización → termina reutilizando la voz ya generada (sin repetirla)", r.ok && /RESULTADO TERMINADA/.test(w2.resultado) && !!t.audio && t.audio.reusedSegments === cached && w2.calls === t.audio.segments - cached && cached >= 2, { reanudar: r.status, cache: cached, reutilizados: t.audio?.reusedSegments, llamadas_nuevas: w2.calls, segmentos: t.audio?.segments });
}

// ---------- 4. Reinicio: el worker murió en «generando» (sin latido) ----------
{
  const p = await newEpisode("en", 1);
  await enqueue(OWNER, p.id);
  const cur = (await store.get(OWNER, p.id))!;
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  await store.put({ ...cur, generation: { ...cur.generation, status: "generando", startedAt: old, heartbeatAt: old } });
  const r = await resumeGeneration(deps, OWNER, p.id);
  const w = await worker(OWNER, p.id);
  const t = (await store.get(OWNER, p.id))!;
  check("R1", "worker interrumpido (sin latido 20 min) → «Reanudar» lo recupera y termina", r.ok && /RESULTADO TERMINADA/.test(w.resultado) && t.generation.status === "terminada", { reanudar: r.status, resultado: w.resultado });
}

// ---------- 5. Remezcla: cambia la música sin volver a sintetizar ----------
if (done.B) {
  const cur = (await getProject(deps, OWNER, done.B.id)).body as AudioProject;
  const s = await saveProject(deps, OWNER, cur.id, { revision: cur.revision, music: { ...cur.music, volume: Math.max(5, cur.music.volume - 20) } });
  const after = s.body as AudioProject;
  const q = await requestRemix(deps, OWNER, cur.id, { revision: after.revision });
  const w = await worker(OWNER, cur.id);
  const t = (await store.get(OWNER, cur.id))!;
  check("M1", "remezcla (USD 0) → nuevo MP3 sin ninguna llamada al motor de voz", q.ok && /RESULTADO TERMINADA/.test(w.resultado) && w.calls === 0 && !!t.audio && t.audio.path !== done.B.audio!.path, { remezcla: q.status, llamadas: w.calls });
}

// ---------- 6. Biblioteca: archivar/restaurar sin borrar; aislamiento entre cuentas ----------
if (done.C) {
  const objs = ownerObjects().length;
  const a = await setArchived(deps, OWNER, done.C.id, true);
  const listA = await listProjects(deps, OWNER);
  const archived = listA.ok && (listA.body as { projects: AudioProject[] }).projects.find((p) => p.id === done.C.id)?.archivedAt;
  const r = await setArchived(deps, OWNER, done.C.id, false);
  const restored = (await store.get(OWNER, done.C.id))!;
  const deletes = storage.log.filter((l: { method: string }) => l.method === "DELETE").length;
  check("L1", "archivar y restaurar conservan proyecto y MP3; cero borrados en Storage", a.ok && !!archived && r.ok && !restored.archivedAt && !!restored.audio && ownerObjects().length >= objs && deletes === 0, { borrados: deletes });
  const other = await listProjects(deps, OTHER);
  const peek = await getProject(deps, OTHER, done.C.id);
  check("L2", "otra cuenta no ve la biblioteca del dueño ni abre su proyecto (404)", other.ok && (other.body as { projects: unknown[] }).projects.length === 0 && peek.status === 404);
  const w3 = writes();
  const w = await worker(OTHER, done.C.id, { AUDIO_STUDIO_VOICE: "demo" });
  check("L3", "worker despachado con una cuenta que no es la dueña → SIN_VOZ (no lee ni escribe nada)", /RESULTADO SIN_VOZ/.test(w.resultado) && w.calls === 0 && writes() === w3, { resultado: w.resultado, escrituras: writes() - w3 });
  const foreign = await newEpisode("es", 1, OTHER);
  const foreignBefore = JSON.stringify(await store.get(OTHER, foreign.id));
  const w4 = writes();
  const w2 = await worker(OWNER, foreign.id);
  check("L4", "payload con el dueño interno pero un proyecto de otra cuenta → RECHAZADO (proyecto inexistente), sin escrituras y el proyecto ajeno intacto", /RESULTADO RECHAZADO proyecto inexistente para ese dueño/.test(w2.resultado) && w2.calls === 0 && writes() === w4 && JSON.stringify(await store.get(OTHER, foreign.id)) === foreignBefore, { resultado: w2.resultado, escrituras: writes() - w4 });
  check("L5", "todo lo escrito queda bajo audio-studio/v1/<cuenta>/", ownerObjects().every((o) => o.startsWith(`${AUDIO_STUDIO_PREFIX}/${OWNER}/`) || o.startsWith(`${AUDIO_STUDIO_PREFIX}/${OTHER}/`)), { objetos: ownerObjects().length });
}

// ---------- 7. Rechazos del worker ----------
{
  const p = await newEpisode("es", 1);
  const cur = (await store.get(OWNER, p.id))!;
  await store.put({ ...cur, generation: { ...cur.generation, status: "en_cola", kind: "generar", heartbeatAt: new Date().toISOString(), authorization: null } });
  const wx = writes();
  const w = await worker(OWNER, p.id);
  check("X1", "en cola sin autorización guardada → RECHAZADO sin sintetizar", /RESULTADO RECHAZADO sin autorización de gasto guardada/.test(w.resultado) && w.calls === 0 && writes() === wx, { resultado: w.resultado, escrituras: writes() - wx });
  const off = await worker(OWNER, p.id, { AUDIO_STUDIO_VOICE: "off" });
  check("X2", "rollback sin código AUDIO_STUDIO_VOICE=off → SIN_VOZ, sin escrituras", /RESULTADO SIN_VOZ/.test(off.resultado) && off.calls === 0 && writes() === wx, { resultado: off.resultado, escrituras: writes() - wx });
  const bad = await worker("no-es-uuid", p.id);
  check("X3", "identificadores inválidos → salida 2 sin tocar nada", bad.code === 2 && /identificadores inválidos/.test(bad.resultado) && writes() === wx, { escrituras: writes() - wx });
}

// ---------- 8. Red y gasto ----------
const blocked = readFileSync(NET_LOG, "utf8").trim().split("\n").filter(Boolean);
check("N1", "cero conexiones fuera de 127.0.0.1 desde el worker (cortafuegos de proceso)", blocked.length === 0, { bloqueadas: blocked.length, ejemplos: blocked.slice(0, 3) });
const allSpent = await Promise.all(Object.values(done).map(async (p) => (await store.get(OWNER, p.id))!.spentUsd));
check("N2", "gasto total USD 0 en todos los episodios", allSpent.every((x) => x === 0), { gastos: allSpent });
note("P1", "producción autenticada (sesión real de Hans, Supabase y GitHub reales)", "NO_PROBADO", "Fuera del alcance del CI por diseño: runbook de 10 minutos en docs/AUDIO-STUDIO-WORKER-PREFLIGHT.md");
note("P2", "voz real ElevenLabs", "BLOCKED", "Requiere autorización de importe de Hans (USD ≈3,04, tope 6)");

// Ninguna comprobación puede saltarse en silencio (p. ej. por un caso previo sin MP3). En los controles negativos
// los saltos que provoca el propio fallo inyectado son esperados, así que Z1 solo se exige en la ejecución normal.
const EXPECTED = ["K1", "K2", "K3", "K4", "K5", "K6", ...["A", "B", "C", "D"].flatMap((c) => [0, 1, 2, 3, 4, 5].map((n) => `${c}${n}`)), "E1", "F1", "F2", "R1", "M1", "L1", "L2", "L3", "L4", "L5", "X1", "X2", "X3", "N1", "N2"];
const missing = EXPECTED.filter((id) => !rows.some((r) => r.id === id));
if (!NEGATIVE) check("Z1", "todas las comprobaciones esperadas se ejecutaron (ninguna se saltó)", missing.length === 0, { esperadas: EXPECTED.length, faltan: missing });

await storage.close();
const fails = rows.filter((r) => r.estado === "FAIL").length;
const pass = rows.filter((r) => r.estado === "PASS").length;
writeFileSync(path.join(OUT, "matriz.json"), JSON.stringify({ controlNegativo: NEGATIVE, pass, faltan: missing, fail: fails, rows, peticionesStorage: storage.log.length }, null, 2));
writeFileSync(path.join(OUT, "matriz.md"), `| Id | Requisito | Estado | Detalle |\n|---|---|---|---|\n${rows.map((r) => `| ${r.id} | ${r.requisito} | ${r.estado} | ${r.detalle.replace(/\|/g, "/").slice(0, 300)} |`).join("\n")}\n`);
console.log(`RESULTADO ${pass} PASS / ${fails} FAIL${NEGATIVE ? ` (control negativo «${NEGATIVE}»: debe tener FAIL)` : ""}`);
process.exit(fails ? 1 : 0);
