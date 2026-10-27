/**
 * Podcast 3.0 — pruebas de render de punta a punta con proveedores SIMULADOS (requiere ffmpeg; USD 0).
 * NO prueban proveedores reales: prueban nuestra orquestación, mezcla, composición, sincronía, costos y reintentos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, copyFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { StudioSpec, STUDIO_VERSION } from "./spec";
import { runEpisode, MemoryRunGuard, DuplicateRunError, preflight, PaidArtifactMissingError, type ArtifactStore } from "./pipeline";
import { MemoryLedger, UnauthorizedChargeError, UncertainChargeError } from "./cost";
import { mockProviders } from "./mocks";
import { ebur128, readPcm, rmsDb, ffprobeDuration } from "./ffmpeg";
import { bundledV2Music, ensureBundledMusic } from "./music-library";
import { licensedMusic } from "../v2/narrate-v2";

const MUSIC = path.join(tmpdir(), "p30-test-music");
const probe = (f: string) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", f], { encoding: "utf8" }).stdout);
const base = { version: STUDIO_VERSION, language: "es", format: "16:9", audio_export: "mp3", budget_usd: 5, target_minutes: 1 };
const A = StudioSpec.parse({ ...base, mode: "narracion", title: "Señal Wow", script: "En 1977 el radiotelescopio Big Ear registró una señal intensa.\n\nEl astrónomo Jerry Ehman escribió Wow en el margen de la impresión.\n\nLa señal nunca volvió a detectarse en Sagitario.",
  participants: [{ id: "A", name: "Narrador", voice_id: "vozNarradorA" }, { id: "B", name: "Voz 2", voice_id: "vozNarradorB" }], visual: { recreations: true }, music: { enabled: true, mood: "misterio", stings: true } });
const B = StudioSpec.parse({ ...base, mode: "avatar", title: "Volcanes", script: "Hola, hoy hablamos de volcanes y su lava ardiente.\n\nEl volcán Olympus Mons está en Marte y es enorme.\n\nLos volcanes crean islas como Hawái.\n\nGracias por ver este episodio sobre volcanes.",
  participants: [{ id: "A", name: "Hans", voice_id: "vozHansSint", avatar: { kind: "existente", avatar_id: "av-hans" } }], visual: { avatar_frequency: 0.5, avatar_max_seconds: 3, recreations: false }, music: { enabled: true, mood: "documental" } });
const C = StudioSpec.parse({ ...base, mode: "dialogo", format: "9:16", title: "Europa", script: "Ana: Bienvenidos, hoy hablamos de Europa con Luis.\nLuis: Gracias Ana, Europa es fascinante.\nAna: ¿Por qué buscar vida en Europa?\nLuis: Porque bajo su hielo hay un océano de agua.\nAna: ¡Increíble!\nLuis: Es un candidato, no una prueba.",
  participants: [{ id: "A", name: "Ana", voice_id: "vozAnaHost", avatar: { kind: "existente", avatar_id: "av-ana" } }, { id: "B", name: "Luis", voice_id: "vozLuisInv", avatar: { kind: "existente", avatar_id: "av-luis" } }],
  visual: { avatar_frequency: 1, avatar_max_seconds: 30, set: "neon" }, music: { enabled: true, mood: "auto" } });

async function render(spec: StudioSpec, opts: { providers?: ReturnType<typeof mockProviders>; ledger?: MemoryLedger; authorizedUsd?: number | null; episode?: string; guard?: MemoryRunGuard; artifacts?: ArtifactStore } = {}) {
  const providers = opts.providers ?? mockProviders({ tonesOnly: true });
  const ledger = opts.ledger ?? new MemoryLedger();
  const dir = await mkdtemp(path.join(tmpdir(), "p30-render-"));
  const r = await runEpisode(spec, { owner: "u1", episode: opts.episode ?? "ep", dir, providers, ledger, guard: opts.guard ?? new MemoryRunGuard(), authorizedUsd: opts.authorizedUsd === undefined ? 5 : opts.authorizedUsd, small: true, musicDir: MUSIC, artifacts: opts.artifacts });
  return { r, providers, ledger };
}
const gapsDb = async (file: string, timeline: { start: number; end: number }[]) => {
  const pcm = await readPcm(file, 16000);
  const gaps = timeline.slice(0, -1).map((e, i) => [e.end + 0.06, timeline[i + 1].start - 0.04]).filter(([a, b]) => b - a > 0.15);
  return gaps.map(([a, b]) => rmsDb(pcm, 16000, a, b)).reduce((s, x) => s + x, 0) / gaps.length;
};

test("música: biblioteca propia generada con LICENSES.md, reconocida por Podcast 2.x (sin PODCAST_MUSIC_DIR)", { timeout: 300_000 }, async () => {
  await ensureBundledMusic(MUSIC);
  const v2 = await bundledV2Music(MUSIC);
  assert.equal(licensedMusic(v2).length, v2.library.length);
  assert.ok(v2.library.some((l) => l.moods.includes("suspense")));
  const q = await ebur128(path.join(MUSIC, "atomivid-misterio.wav"));
  assert.ok(q.lufs > -16 && q.lufs < -12 && q.clipped === 0, JSON.stringify(q));
});

test("modo A: narración 2 voces alternadas, imágenes sin repetir, música presente en pausas, −16 LUFS, TP ≤ −1, sincronía A/V, MP3", { timeout: 600_000 }, async () => {
  const { r, providers } = await render(A);
  assert.deepEqual(providers.calls.tts.map((c) => c.split(":")[0]), ["vozNarradorA", "vozNarradorB", "vozNarradorA"], "voces alternadas por párrafo");
  const assets = r.plan.shots.filter((s) => s.asset_id).map((s) => s.asset_id);
  assert.equal(new Set(assets).size, assets.length, "sin imágenes repetidas");
  assert.ok(r.plan.shots.filter((s) => s.kind === "recreacion").every((s) => s.label === "Recreación"));
  const q = await ebur128(r.mp4!);
  assert.ok(Math.abs(q.lufs + 16) <= 1, `LUFS ${q.lufs}`); assert.ok(q.truePeak <= -1, `TP ${q.truePeak}`); assert.equal(q.clipped, 0);
  const p = probe(r.mp4!); const v = p.streams.find((s: { codec_type: string }) => s.codec_type === "video"), a = p.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  assert.equal(v.codec_name, "h264"); assert.equal(a.codec_name, "aac"); assert.equal(v.width, 640);
  const vd = await ffprobeDuration(r.mp4!); const ad = r.timeline[r.timeline.length - 1].end;
  assert.ok(vd >= ad, "el video no corta la última voz");
  assert.equal(probe(r.audio).streams[0].codec_name, "mp3");
  // Música: la misma producción con música apagada tiene silencio en las pausas; con música, energía clara.
  const off = await render(StudioSpec.parse({ ...A, music: { ...A.music, enabled: false } }));
  const on = await gapsDb(r.mp4!, r.timeline), silent = await gapsDb(off.r.mp4!, off.r.timeline);
  assert.ok(on > -45 && on - silent > 15, `pausas con música ${on.toFixed(1)} dBFS vs sin música ${silent.toFixed(1)} dBFS`);
  assert.equal(off.r.musicTrack, null); assert.equal(r.musicTrack, "atomivid-misterio.wav");
});

test("modo B: avatar por segmento con tope de duración y frecuencia; reintento completo no vuelve a pagar (caché idempotente)", { timeout: 600_000 }, async () => {
  const ledger = new MemoryLedger(), providers = mockProviders({ tonesOnly: true });
  const { r } = await render(B, { ledger, providers });
  const av = r.plan.shots.filter((s) => s.kind === "avatar_a");
  assert.equal(av.length, providers.calls.avatar.length, "un clip de avatar por aparición");
  assert.equal(av.length, 2, "50 % de 4 turnos");
  assert.ok(av.every((s) => s.end - s.start <= 3 + 1e-6), "duración máxima por aparición");
  const t1 = r.timeline.find((t) => t.turn_id === av[0].turn_id)!;
  assert.ok(Math.abs(av[0].start - t1.start) < 1e-6, "el avatar empieza con la voz de su turno (sincronía labial)");
  const spent = r.spentUsd, calls = providers.calls.avatar.length + providers.calls.tts.length;
  const again = await render(B, { ledger, providers });
  assert.equal(again.r.paidOps, 0); assert.ok(again.r.reusedOps >= calls);
  assert.equal(providers.calls.avatar.length + providers.calls.tts.length, calls, "sin llamadas nuevas");
  assert.equal(again.r.spentUsd, spent, "sin doble cobro");
});

test("modo C: dos voces, two-shot/sobre el hombro compuestos, 9:16; fallo incierto del avatar bloquea reintento sin doble cobro", { timeout: 600_000 }, async () => {
  const { r, providers } = await render(C);
  assert.deepEqual([...new Set(providers.calls.tts.map((c) => c.split(":")[0]))].sort(), ["vozAnaHost", "vozLuisInv"]);
  const kinds = new Set(r.plan.shots.map((s) => s.kind));
  assert.ok(kinds.has("two_shot") && kinds.has("over_shoulder"), [...kinds].join());
  const v = probe(r.mp4!).streams.find((s: { codec_type: string }) => s.codec_type === "video");
  assert.deepEqual([v.width, v.height], [360, 640]);
  assert.ok((await stat(r.mp4!)).size > 10_000);
  const ledger = new MemoryLedger(), flaky = mockProviders({ tonesOnly: true, failAvatarTimes: 1 });
  await assert.rejects(render(C, { ledger, providers: flaky, episode: "ep-c2" }), /tiempo de espera/);
  assert.equal([...ledger.rows.values()].filter((x) => x.state === "uncertain").length, 1);
  assert.equal([...ledger.rows.values()].filter((x) => x.state === "reserved").length, 0, "nada queda reservado sin conciliar");
  const before = flaky.calls.avatar.length;
  await assert.rejects(render(C, { ledger, providers: flaky, episode: "ep-c2" }), UncertainChargeError);
  assert.equal(flaky.calls.avatar.length, before, "no se vuelve a llamar al proveedor");
});

test("control de costos: sin autorización suficiente no hay ninguna llamada; ejecución duplicada rechazada; rechazo de voz liberado y reintentado", { timeout: 600_000 }, async () => {
  const p0 = mockProviders({ tonesOnly: true });
  await assert.rejects(render(B, { providers: p0, authorizedUsd: 0.001 }), UnauthorizedChargeError);
  assert.equal(p0.calls.tts.length + p0.calls.avatar.length, 0);
  const pf = await preflight(B, mockProviders({ tonesOnly: true }));
  assert.ok(pf.estimate.totalUsd > 0 && pf.estimate.lines.length === 5);
  const guard = new MemoryRunGuard();
  const [x, y] = await Promise.allSettled([render(A, { guard, episode: "dup" }), render(A, { guard, episode: "dup" })]);
  assert.equal([x, y].filter((s) => s.status === "rejected" && s.reason instanceof DuplicateRunError).length, 1);
  assert.equal([x, y].filter((s) => s.status === "fulfilled").length, 1);
  const ledger = new MemoryLedger(), rej = mockProviders({ tonesOnly: true, failTtsRejectTimes: 1 });
  await assert.rejects(render(A, { ledger, providers: rej, episode: "rej" }), /sin cargo/);
  assert.equal([...ledger.rows.values()].filter((r) => r.state === "released").length, 1);
  const ok = await render(A, { ledger, providers: rej, episode: "rej" });
  assert.ok(ok.r.mp4);
});

// ── Cierre de auditoría Podcast V3 (USD 0, proveedores SIMULADOS) ─────────────────────────────────────────────

const grayFrame = (file: string, n: number, w: number, h: number) => spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-s", `${w}x${h}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 24 }).stdout as Buffer;

test("modo A solo audio: entrega solo el audio — sin imágenes, sin planos, sin MP4", { timeout: 600_000 }, async () => {
  const audioOnly = StudioSpec.parse({ ...A, output: "audio", visual: { ...A.visual, provider: "solo_set", recreations: false } });
  const { r, providers } = await render(audioOnly);
  assert.equal(r.mp4, null, "no se genera video");
  assert.equal(r.shotFiles.length, 0, "no se renderiza ningún plano");
  assert.equal(providers.calls.images.length + providers.calls.recreate.length + providers.calls.avatar.length, 0, "ni búsquedas de imágenes ni recreaciones ni avatar");
  assert.equal(providers.calls.tts.length, 3);
  const p = probe(r.audio);
  assert.equal(p.streams.length, 1); assert.equal(p.streams[0].codec_name, "mp3");
  const q = await ebur128(r.audio);
  assert.ok(Math.abs(q.lufs + 16) <= 1 && q.truePeak <= -1 && q.clipped === 0, JSON.stringify(q));
  assert.equal(r.musicTrack, "atomivid-misterio.wav");
});

test("modo C: quien escucha en el plano general se mueve (cámara sutil), no es un fotograma congelado", { timeout: 600_000 }, async () => {
  const { r } = await render(C, { episode: "ep-listener" });
  const W = 360, H = 640;
  const idx = r.plan.shots.findIndex((s, i) => s.kind === "two_shot" && (s.end - s.start) > 1.6 && r.shotFiles[i]);
  assert.ok(idx >= 0, "hay un plano general con duración suficiente");
  const shot = r.plan.shots[idx], file = r.shotFiles[idx];
  const frames = Number(spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim());
  // Región de quien escucha (9:16: hablante arriba o abajo según el lado); se evitan fundidos y subtítulos.
  const speakerFirst = shot.speaker === "A"; // C no invierte lados
  const [y0, y1] = speakerFirst ? [Math.round(H * 0.53), Math.round(H * 0.74)] : [Math.round(H * 0.11), Math.round(H * 0.44)];
  const a = grayFrame(file, 8, W, H), b = grayFrame(file, frames - 9, W, H);
  let changed = 0, total = 0;
  for (let y = y0; y < y1; y++) for (let x = Math.round(W * 0.12); x < Math.round(W * 0.88); x++) { total++; if (Math.abs(a[y * W + x] - b[y * W + x]) > 8) changed++; }
  assert.ok(changed / total > 0.005, `quien escucha cambió en ${(100 * changed / total).toFixed(2)} % de sus píxeles`);
  assert.ok(changed / total < 0.6, "movimiento sutil, no un corte");
});

test("avatar desde foto: la subida al proveedor pasa por el libro — un reintento no vuelve a subir ni cobrar", { timeout: 600_000 }, async () => {
  const foto = StudioSpec.parse({ ...B, participants: [{ ...B.participants[0], avatar: { kind: "foto", photo_path: "u1/podcast-studio/photos/x.jpg", consent: { given: true, at: "2026-10-23T00:00:00Z", text: "Consentimiento expreso de prueba" } } }] });
  const ledger = new MemoryLedger(), providers = mockProviders({ tonesOnly: true });
  await render(foto, { ledger, providers, episode: "ep-foto" });
  assert.equal(providers.calls.prepare.length, 1);
  assert.ok(providers.calls.avatar.every((c) => c.startsWith("asset:mock-")), "los clips usan la referencia preparada");
  assert.ok([...ledger.rows.values()].some((x) => x.op === "avatar_prepare" && x.state === "settled"));
  await render(foto, { ledger, providers, episode: "ep-foto" });
  assert.equal(providers.calls.prepare.length, 1, "reintento: la foto no se vuelve a subir");
});

test("barreras previas: saldo insuficiente o presupuesto menor que la estimación → cero llamadas de pago", { timeout: 600_000 }, async () => {
  const { ProviderNotReadyError } = await import("./pipeline");
  const { BudgetExceededError } = await import("./cost");
  const p1 = { ...mockProviders({ tonesOnly: true }), readiness: async () => "HeyGen: saldo USD 0.00" };
  const ledger = new MemoryLedger();
  await assert.rejects(render(B, { providers: p1, ledger, episode: "ep-saldo" }), ProviderNotReadyError);
  assert.equal(p1.calls.tts.length + p1.calls.avatar.length, 0); assert.equal(ledger.rows.size, 0, "nada reservado");
  const p2 = mockProviders({ tonesOnly: true });
  await assert.rejects(render(StudioSpec.parse({ ...B, budget_usd: 0.01 }), { providers: p2, episode: "ep-tope" }), BudgetExceededError);
  assert.equal(p2.calls.tts.length + p2.calls.avatar.length, 0);
});

/** Almacén de lo pagado en disco (en el worker real: Supabase Storage). Simula que el runner siguiente es OTRA máquina. */
async function diskArtifacts(): Promise<ArtifactStore & { puts: number }> {
  const root = await mkdtemp(path.join(tmpdir(), "p30-paid-"));
  const st = { puts: 0, async put(key: string, local: string) { st.puts++; const ref = `store:${key.slice(0, 24)}${path.extname(local)}`; await copyFile(local, path.join(root, ref.slice(6))); return ref; },
    async get(ref: string, dest: string) { await copyFile(path.join(root, ref.slice(6)), dest); } };
  return st;
}

test("reintento en OTRO runner: lo pagado (voz y clips) se recupera del almacén — cero llamadas y cero USD nuevos", { timeout: 600_000 }, async () => {
  const ledger = new MemoryLedger(), providers = mockProviders({ tonesOnly: true }), artifacts = await diskArtifacts();
  const first = await render(B, { ledger, providers, artifacts, episode: "ep-runner" });
  const calls = providers.calls.tts.length + providers.calls.avatar.length;
  assert.equal(artifacts.puts, first.r.paidOps - 0, "todo lo pagado con archivo queda en el almacén");
  await rm(path.dirname(first.r.mp4!), { recursive: true, force: true }); // el runner anterior desaparece
  const second = await render(B, { ledger, providers, artifacts, episode: "ep-runner" });
  assert.equal(second.r.paidOps, 0); assert.equal(providers.calls.tts.length + providers.calls.avatar.length, calls, "sin llamadas nuevas");
  assert.equal(second.r.spentUsd, first.r.spentUsd, "sin cargo nuevo");
  assert.ok((await stat(second.r.mp4!)).size > 10_000);
  // Sin almacén (ruta local de otro runner): falla claro y NO vuelve a pagar.
  const l2 = new MemoryLedger(), p2 = mockProviders({ tonesOnly: true });
  const a = await render(B, { ledger: l2, providers: p2, episode: "ep-legacy" });
  await rm(path.dirname(a.r.mp4!), { recursive: true, force: true });
  const n2 = p2.calls.tts.length + p2.calls.avatar.length;
  await assert.rejects(render(B, { ledger: l2, providers: p2, episode: "ep-legacy" }), PaidArtifactMissingError);
  assert.equal(p2.calls.tts.length + p2.calls.avatar.length, n2, "nunca se repaga lo que no se encuentra");
});

test("duraciones reales mayores que la estimación: se para ANTES de pedir clips de avatar; al ampliar el monto, la voz se reutiliza", { timeout: 600_000 }, async () => {
  const providers = mockProviders({ tonesOnly: true, ttsStretch: 2.5 }), ledger = new MemoryLedger(), artifacts = await diskArtifacts();
  const B2 = StudioSpec.parse({ ...B, visual: { ...B.visual, avatar_max_seconds: 60 } }); // sin tope corto: el clip dura lo que la voz real
  const pf = await preflight(B2, providers);
  const exact = Math.round((pf.estimate.totalUsd - pf.estimate.lines.find((l) => l.concept === "render")!.usd) * 1e4) / 1e4;
  const { BudgetExceededError } = await import("./cost");
  await assert.rejects(render(B2, { ledger, providers, artifacts, authorizedUsd: exact, episode: "ep-real" }), BudgetExceededError);
  assert.equal(providers.calls.avatar.length, 0, "ningún clip pedido sin presupuesto para terminar");
  const tts = providers.calls.tts.length; assert.ok(tts > 0);
  const ok = await render(B2, { ledger, providers, artifacts, authorizedUsd: 5, episode: "ep-real" });
  assert.equal(providers.calls.tts.length, tts, "la voz pagada se reutiliza");
  assert.ok(ok.r.mp4 && providers.calls.avatar.length > 0);
});

test("modo C: fallo al leer la foto fija DESPUÉS de pagar voz y clips → reintento del mismo episodio sin llamadas ni cargos nuevos", { timeout: 600_000 }, async () => {
  // Caso real P2 (episodio 0de4b445): 8 voces + 1 clip pagados, luego «FOTO» al leer la foto fija del oyente.
  const ledger = new MemoryLedger(), providers = mockProviders({ tonesOnly: true }), artifacts = await diskArtifacts();
  const realStill = providers.avatar.still.bind(providers.avatar);
  let broken = true;
  providers.avatar.still = async (ref: string, dest: string) => { if (broken) throw new Error("FOTO"); return realStill(ref, dest); };
  await assert.rejects(render(C, { ledger, providers, artifacts, episode: "ep-foto" }), /FOTO/);
  const ttsPaid = providers.calls.tts.length, clipsPaid = providers.calls.avatar.length;
  assert.ok(ttsPaid > 0 && clipsPaid > 0, "voz y al menos un clip ya pagados antes del fallo");
  const before = new Map([...ledger.rows].map(([k, r]) => [k, JSON.stringify(r)]));
  broken = false; // arreglo desplegado (foto en el bucket correcto)
  const retry = await render(C, { ledger, providers, artifacts, episode: "ep-foto" });
  assert.equal(providers.calls.tts.length, ttsPaid, "ninguna voz se vuelve a pedir");
  assert.equal(providers.calls.avatar.length, clipsPaid + (retry.r.paidOps), "solo se piden los clips que faltaban");
  assert.ok(retry.r.mp4 && (await stat(retry.r.mp4)).size > 10_000, "el episodio se completa");
  for (const [k, r] of before) assert.equal(JSON.stringify(ledger.rows.get(k)), r, `operación pagada ${k} reutilizada sin cambios (sin segundo cobro)`);
  const newRows = [...ledger.rows.keys()].filter((k) => !before.has(k));
  assert.equal(newRows.length, retry.r.paidOps, "las únicas operaciones nuevas son las que faltaban");
  assert.ok(newRows.every((k) => !/tts|voz|voice/i.test(k)), `sin voz nueva: ${newRows.join(",")}`);
});

test("P2 real reproducido: guion de 8 turnos, mismo avatar existente para A y B; «FOTO» tras pagar 8 voces y clips → reintento del mismo episodio: 8 voces reutilizadas, clips pagados reutilizados, «ready» con MP4 y MP3 reproducibles y firmables", { timeout: 900_000 }, async () => {
  const P2 = StudioSpec.parse({ ...base, mode: "dialogo", title: "Prueba real P2", script: "Ana: ¿De verdad un cometa puede venir de otra estrella?\nLuis: Sí, y lo sabemos por su velocidad: ningún objeto ligado al Sol va tan rápido.\nAna: ¿Y no podría ser un error de medición?\nLuis: Lo midieron varios observatorios durante semanas. Los datos coinciden.\nAna: Entonces, ¿qué nos dice de su origen?\nLuis: Que los sistemas planetarios expulsan restos, y algunos cruzan el espacio durante millones de años.\nAna: Me cuesta imaginarlo. ¿Volverá?\nLuis: No. Va de salida, y nunca más lo veremos.",
    participants: [{ id: "A", name: "Ana", voice_id: "CeFSZuaHs4SxcBxb9nCr", avatar: { kind: "existente", avatar_id: "av-hans" } }, { id: "B", name: "Luis", voice_id: "vozLuisInv", avatar: { kind: "existente", avatar_id: "av-hans" } }],
    visual: { avatar_frequency: 0.5, avatar_max_seconds: 20, recreations: false }, music: { enabled: true, mood: "auto" } });
  const ledger = new MemoryLedger(), providers = mockProviders({ tonesOnly: true }), artifacts = await diskArtifacts();
  const realStill = providers.avatar.still.bind(providers.avatar);
  let broken = true;
  providers.avatar.still = async (ref: string, dest: string) => { if (broken) throw new Error("FOTO"); return realStill(ref, dest); };
  await assert.rejects(render(P2, { ledger, providers, artifacts, episode: "0de4b445" }), /FOTO/);
  assert.equal(providers.calls.tts.length, 8, "8 voces pagadas antes del fallo (como en producción)");
  const clipsBefore = providers.calls.avatar.length; assert.ok(clipsBefore >= 1, "al menos un clip de avatar pagado antes del fallo");
  const before = new Map([...ledger.rows].map(([k, r]) => [k, JSON.stringify(r)]));
  const settledBefore = [...ledger.rows.values()].filter((r) => r.state === "settled");
  assert.ok(settledBefore.length >= 9 && [...ledger.rows.values()].every((r) => r.state === "settled"), "todo lo pagado quedó asentado; nada incierto ni reservado");

  broken = false; // la foto fija se lee del bucket correcto
  const retry = await render(P2, { ledger, providers, artifacts, episode: "0de4b445" });
  assert.equal(providers.calls.tts.length, 8, "reintento: cero voces nuevas (las 8 se reutilizan)");
  for (const [k, r] of before) assert.equal(JSON.stringify(ledger.rows.get(k)), r, `operación pagada ${k} reutilizada sin cambios`);
  const newKeys = [...ledger.rows.keys()].filter((k) => !before.has(k));
  assert.equal(providers.calls.avatar.length - clipsBefore, newKeys.length, "solo se piden los clips que aún no existían; ninguno pagado se repite");
  assert.ok(newKeys.every((k) => ledger.rows.get(k)!.provider !== providers.tts.name), "ninguna operación de voz nueva");
  assert.equal(retry.r.paidOps, newKeys.length);
  console.log("P2_SIM", JSON.stringify({ voicesFirstRun: 8, clipsFirstRun: clipsBefore, settledReusedOps: before.size, voicesOnRetry: providers.calls.tts.length - 8, newClipsOnRetry: newKeys.length }));

  // «ready»: el pipeline entrega MP4 y audio decodificables (lo que el worker sube y la app firma).
  assert.ok(retry.r.ok && retry.r.mp4 && retry.r.audio);
  const probe = (f: string) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration", "-of", "json", f], { encoding: "utf8" }).stdout);
  const v = probe(retry.r.mp4!), a = probe(retry.r.audio);
  assert.ok(v.streams.some((x: { codec_type: string }) => x.codec_type === "video") && v.streams.some((x: { codec_type: string }) => x.codec_type === "audio"), "MP4 con video y audio");
  assert.ok(Number(v.format.duration) > 10 && Number(a.format.duration) > 10, "MP4 y MP3 con duración real");
  const dec = spawnSync("ffmpeg", ["-v", "error", "-i", retry.r.mp4!, "-f", "null", "-"], { encoding: "utf8" });
  assert.equal(dec.status, 0, `el MP4 se decodifica completo (reproducible): ${dec.stderr.slice(0, 200)}`);

  // Descarga desde la cuenta: la ruta de la app firma MP4 y MP3 del episodio «ready» del dueño.
  const { episodeAction } = await import("./api");
  const id = "11111111-1111-4111-8111-0de4b4450000";
  const signed: string[] = [];
  const out = await episodeAction("u1", { id, user_id: "u1", title: "Prueba real P2", mode: "dialogo", spec: P2, status: "ready", estimate: {}, estimated_usd: 0.52, authorized_usd: 3, authorized_at: "", run_started_at: "", progress: null, result: null,
    video_path: `u1/podcast-studio/${id}/episodio.mp4`, audio_path: `u1/podcast-studio/${id}/episodio.mp3`, cost_usd: 0.3, error: null, created_at: "", updated_at: "" } as never, async (p) => { signed.push(p); return `signed:${p}`; });
  assert.equal(out.body.video_url, `signed:u1/podcast-studio/${id}/episodio.mp4`);
  assert.equal(out.body.audio_url, `signed:u1/podcast-studio/${id}/episodio.mp3`);
});
