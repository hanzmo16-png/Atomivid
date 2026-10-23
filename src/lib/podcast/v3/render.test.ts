/**
 * Podcast 3.0 — pruebas de render de punta a punta con proveedores SIMULADOS (requiere ffmpeg; USD 0).
 * NO prueban proveedores reales: prueban nuestra orquestación, mezcla, composición, sincronía, costos y reintentos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { StudioSpec, STUDIO_VERSION } from "./spec";
import { runEpisode, MemoryRunGuard, DuplicateRunError, preflight } from "./pipeline";
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

async function render(spec: StudioSpec, opts: { providers?: ReturnType<typeof mockProviders>; ledger?: MemoryLedger; authorizedUsd?: number | null; episode?: string; guard?: MemoryRunGuard } = {}) {
  const providers = opts.providers ?? mockProviders({ tonesOnly: true });
  const ledger = opts.ledger ?? new MemoryLedger();
  const dir = await mkdtemp(path.join(tmpdir(), "p30-render-"));
  const r = await runEpisode(spec, { owner: "u1", episode: opts.episode ?? "ep", dir, providers, ledger, guard: opts.guard ?? new MemoryRunGuard(), authorizedUsd: opts.authorizedUsd === undefined ? 5 : opts.authorizedUsd, small: true, musicDir: MUSIC });
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
  const q = await ebur128(r.mp4);
  assert.ok(Math.abs(q.lufs + 16) <= 1, `LUFS ${q.lufs}`); assert.ok(q.truePeak <= -1, `TP ${q.truePeak}`); assert.equal(q.clipped, 0);
  const p = probe(r.mp4); const v = p.streams.find((s: { codec_type: string }) => s.codec_type === "video"), a = p.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  assert.equal(v.codec_name, "h264"); assert.equal(a.codec_name, "aac"); assert.equal(v.width, 640);
  const vd = await ffprobeDuration(r.mp4); const ad = r.timeline[r.timeline.length - 1].end;
  assert.ok(vd >= ad, "el video no corta la última voz");
  assert.equal(probe(r.audio).streams[0].codec_name, "mp3");
  // Música: la misma producción con música apagada tiene silencio en las pausas; con música, energía clara.
  const off = await render(StudioSpec.parse({ ...A, music: { ...A.music, enabled: false } }));
  const on = await gapsDb(r.mp4, r.timeline), silent = await gapsDb(off.r.mp4, off.r.timeline);
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
  const v = probe(r.mp4).streams.find((s: { codec_type: string }) => s.codec_type === "video");
  assert.deepEqual([v.width, v.height], [360, 640]);
  assert.ok((await stat(r.mp4)).size > 10_000);
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
