/**
 * P1 de la prueba real 2026-10-31 (episodio ba27b6f7, «Solo estudio y anfitriones», frecuencia de avatar 0,5): en los
 * turnos sin avatar no había imagen y el plano quedaba en «transición» = el estudio VACÍO (~25 de 54 s sin nadie).
 * Ahora esos turnos muestran a los anfitriones sentados en el estudio en un plano fijo (su foto, sin labios ni costo de
 * avatar). Proveedores simulados, USD 0 (requiere ffmpeg).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { planEpisode } from "./editorial";
import { parseLabeledScript } from "./script";
import { lipTimeline } from "./studio";
import { StudioSpec, STUDIO_VERSION } from "./spec";
import { preflight, runEpisode, MemoryRunGuard, stillListeners } from "./pipeline";
import { MemoryLedger } from "./cost";
import { mockProviders } from "./mocks";

const SCRIPT = [
  "Valeria: Bienvenidos. Hoy hablamos de los sumerios y de la escritura más antigua que conocemos.",
  "Víctor: Gracias, Valeria. Hace más de cinco mil años marcaban tablillas de arcilla con un punzón.",
  "Valeria: ¿Y qué escribían en esas tablillas? Imagino que historias de dioses y reyes.",
  "Víctor: Casi todo eran cuentas: cebada, ovejas, salarios y contratos.",
  "Valeria: Entonces la contabilidad llegó antes que la literatura.",
  "Víctor: Exacto. Siglos después aparecieron leyes, cartas y relatos.",
  "Valeria: Una idea práctica que terminó cambiando la historia.",
  "Víctor: Nos escuchamos en el próximo episodio.",
].join("\n");
const turns = parseLabeledScript(SCRIPT)!.turns;
const AVATAR = new Set(["avatar_a", "avatar_b", "two_shot", "over_shoulder"]);

test("plan «Solo estudio» (sin imágenes, frecuencia 0,5, dos anfitriones): ningún turno con el estudio vacío", () => {
  const plan = planEpisode({ mode: "dialogo", turns, assets: [], avatarFrequency: 0.5, avatarMaxSeconds: 10, recreations: false, hasAvatar: { A: true, B: true }, introSeconds: 3 });
  const turnShots = plan.shots.filter((s) => s.turn_id);
  assert.equal(turnShots.filter((s) => s.kind === "transicion").length, 0, "ningún turno en transición (estudio vacío)");
  const quiet = turnShots.filter((s) => s.kind === "estudio_quieto");
  assert.ok(quiet.length >= 3, `los turnos sin avatar muestran a los anfitriones: ${quiet.length}`);
  assert.ok(quiet.every((s) => JSON.stringify(s.people) === '["A","B"]'), "los dos sentados");
  assert.ok(turnShots.filter((s) => AVATAR.has(s.kind)).length >= 3, "la frecuencia de avatar (costo) no cambia");
  // Nadie mueve los labios en el plano fijo (no es un clip con lip-sync).
  for (const seg of lipTimeline(plan).filter((x) => x.shot === "estudio_quieto")) assert.deepEqual(seg.lips, { A: "reposo", B: "reposo" });
  // Con el tope por aparición, el resto del turno tampoco queda vacío.
  const capped = planEpisode({ mode: "dialogo", turns, assets: [], avatarFrequency: 1, avatarMaxSeconds: 2, recreations: false, hasAvatar: { A: true, B: true } });
  assert.equal(capped.shots.filter((s) => s.turn_id && s.kind === "transicion").length, 0);
  // Presentador (un anfitrión): solo él aparece en el plano fijo. Narración sin avatar: sigue la transición (no hay nadie).
  const solo = planEpisode({ mode: "avatar", turns: turns.map((t) => ({ ...t, speaker: "A" as const })), assets: [], avatarFrequency: 0.5, avatarMaxSeconds: 10, recreations: false, hasAvatar: { A: true, B: false } });
  assert.ok(solo.shots.filter((s) => s.kind === "estudio_quieto").every((s) => JSON.stringify(s.people) === '["A"]'));
  const narr = planEpisode({ mode: "narracion", turns, assets: [], avatarFrequency: 0, avatarMaxSeconds: 10, recreations: false, hasAvatar: { A: false, B: false } });
  assert.ok(narr.shots.filter((s) => s.turn_id).every((s) => s.kind === "transicion"));
});

const base = { version: STUDIO_VERSION, language: "es", format: "16:9", audio_export: "mp3", budget_usd: 5, target_minutes: 1 };
const spec = (format: "16:9" | "9:16") => StudioSpec.parse({ ...base, format, mode: "dialogo", title: "Sumerios", topic: "los sumerios", script: SCRIPT.replace(/^Valeria/gm, "Ana").replace(/^Víctor/gm, "Luis"),
  participants: [{ id: "A", name: "Ana", voice_id: "vozAnaHost", avatar: { kind: "existente", avatar_id: "av-ana" } }, { id: "B", name: "Luis", voice_id: "vozLuisInv", avatar: { kind: "existente", avatar_id: "av-luis" } }],
  visual: { provider: "solo_set", avatar_frequency: 0.5, avatar_max_seconds: 10, recreations: false, set: "calido" }, music: { enabled: false, mood: "auto" } });

test("episodio «Solo estudio» simulado: los planos fijos salen con los anfitriones, sin clips ni USD extra, y la foto se comprueba antes de pagar", { timeout: 600_000 }, async () => {
  for (const format of ["16:9", "9:16"] as const) {
    const s = spec(format);
    const pf = await preflight(s, mockProviders({ tonesOnly: true }));
    const quiet = pf.plan.shots.filter((x) => x.kind === "estudio_quieto").length;
    const clips = pf.plan.shots.filter((x) => AVATAR.has(x.kind)).length;
    assert.ok(quiet > 0 && clips > 0);
    assert.deepEqual(stillListeners(s, pf.plan), ["A", "B"]);
    // El costo estimado solo cuenta los clips de avatar (el plano fijo es gratis).
    const avatarLine = pf.estimate.lines.filter((l) => /avatar/i.test(l.concept)).reduce((n, l) => n + l.usd, 0);
    const providers = mockProviders({ tonesOnly: true });
    const ledger = new MemoryLedger();
    const dir = await mkdtemp(path.join(tmpdir(), `p30-quieto-${format.replace(":", "x")}-`));
    const r = await runEpisode(s, { owner: "u1", episode: `ep-${format}`, dir, providers, ledger, guard: new MemoryRunGuard(), authorizedUsd: 5, small: true });
    assert.ok(r.mp4);
    const planQuiet = r.plan.shots.map((x, i) => ({ x, i })).filter(({ x }) => x.kind === "estudio_quieto");
    assert.ok(planQuiet.length > 0);
    assert.equal(providers.calls.avatar.length, r.plan.shots.filter((x) => AVATAR.has(x.kind)).length, `${format}: un clip por plano de avatar, ninguno por plano fijo`);
    assert.ok(avatarLine >= 0);
    // Fotograma del plano fijo: hay personas sobre el estudio (no el set solo). Comparado con el fondo del set renderizado
    // sin nadie (transición), el plano fijo difiere en una zona amplia (los dos cuerpos).
    const shotFile = r.shotFiles[planQuiet[0].i];
    const raw = path.join(dir, "quieto.rgb");
    spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", "0.3", "-i", shotFile, "-frames:v", "1", "-vf", "scale=160:-2,format=rgb24", "-f", "rawvideo", raw]);
    const { renderShot, frameFor } = await import("./compose");
    const empty = await renderShot(dir, 900, { turn_id: "X", speaker: "A", kind: "transicion", start: 0, end: 1, reason: "" }, 25, {}, { set: "calido", frame: frameFor(format, true), swap: false, small: true, fade: false });
    const rawE = path.join(dir, "vacio.rgb");
    spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", "0.3", "-i", empty, "-frames:v", "1", "-vf", "scale=160:-2,format=rgb24", "-f", "rawvideo", rawE]);
    const a = readFileSync(raw), b = readFileSync(rawE);
    assert.equal(a.length, b.length);
    let diff = 0; for (let i = 0; i + 2 < a.length; i += 3) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) diff++;
    const share = diff / (a.length / 3);
    assert.ok(share > 0.05, `${format}: el plano fijo muestra a los anfitriones (${(share * 100).toFixed(1)} % del cuadro distinto del estudio vacío)`);
  }
});

// ——— Render de los planos fijos: continuidad visual con el plano general, lados, movimiento y duración ———
async function people(dir: string) {
  // Dos «personas» recortadas como fotos fijas (cara magenta = A, cian = B), con su alfa; fuera del alfa, verde puro.
  const mk = async (name: string, color: string) => {
    const fg = path.join(dir, `${name}-fg.png`), a = path.join(dir, `${name}-a.png`);
    spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=lime:s=720x1280", "-vf", `drawbox=x=160:y=150:w=400:h=1130:c=gray:t=fill,drawbox=x=260:y=200:w=200:h=200:c=${color}:t=fill`, "-frames:v", "1", fg]);
    spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=720x1280", "-vf", "drawbox=x=160:y=150:w=400:h=1130:c=white:t=fill", "-frames:v", "1", a]);
    return { fg, alpha: a, w: 720, h: 1280, face: [260, 200, 200, 200] as [number, number, number, number], still: true };
  };
  return { A: await mk("a", "magenta"), B: await mk("b", "cyan") };
}
const isA = (r: number, g: number, b: number) => r > 170 && b > 170 && g < 90, isB = (r: number, g: number, b: number) => g > 170 && b > 170 && r < 90;
const isLime = (r: number, g: number, b: number) => g > 200 && r < 80 && b < 80;
/** Fotograma `t` (s) en RGB: centroide y cantidad de píxeles que cumplen `test`. */
function blob(file: string, t: number, w: number, test: (r: number, g: number, b: number) => boolean) {
  const raw = `${file}.${t}.rgb`;
  spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:-2,format=rgb24`, "-f", "rawvideo", raw]);
  const b = readFileSync(raw); let n = 0, sx = 0, sy = 0;
  for (let i = 0; i + 2 < b.length; i += 3) if (test(b[i], b[i + 1], b[i + 2])) { const px = i / 3; n++; sx += px % w; sy += Math.floor(px / w); }
  return { n, x: n ? sx / n : -1, y: n ? sy / n : -1, buf: b };
}

test("render del plano fijo: mismas posiciones que el plano general (continuidad), A izquierda y B derecha, lados invertidos, sin fondo original", { timeout: 300_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "p30-quieto-cont-"));
  const { A, B } = await people(dir);
  const { renderShot, frameFor } = await import("./compose");
  const o = { set: "calido" as const, frame: frameFor("16:9", true), swap: false, small: true, fade: false };
  const quiet = await renderShot(dir, 1, { turn_id: "T003", speaker: "B", kind: "estudio_quieto", people: ["A", "B"], start: 0, end: 2, reason: "" }, 50, { speakerMatte: B, listenerMatte: A }, o);
  const general = await renderShot(dir, 2, { turn_id: "T001", speaker: "B", kind: "two_shot", start: 0, end: 2, reason: "" }, 50, { speakerMatte: B, listenerMatte: A }, o);
  const W = 640;
  const qa = blob(quiet, 1, W, isA), qb = blob(quiet, 1, W, isB), ga = blob(general, 1, W, isA), gb = blob(general, 1, W, isB);
  assert.ok(qa.n > 50 && qb.n > 50, `los dos anfitriones están en el plano fijo: ${qa.n}/${qb.n}`);
  assert.ok(qa.x < W / 2 && qb.x > W / 2, `A a la izquierda y B a la derecha: ${qa.x.toFixed(0)} / ${qb.x.toFixed(0)}`);
  // Continuidad: cada uno ocupa el MISMO lugar y tamaño que en el plano general con avatar (corte sin salto).
  for (const [q, g, who] of [[qa, ga, "A"], [qb, gb, "B"]] as const) {
    assert.ok(Math.abs(q.x - g.x) < 8 && Math.abs(q.y - g.y) < 8, `${who} en el mismo sitio que en el plano general: ${q.x.toFixed(0)},${q.y.toFixed(0)} vs ${g.x.toFixed(0)},${g.y.toFixed(0)}`);
    assert.ok(Math.abs(q.n - g.n) / g.n < 0.15, `${who} del mismo tamaño: ${q.n} vs ${g.n}`);
  }
  assert.ok(blob(quiet, 1, W, isLime).n < 20, "el fondo original de la foto no entra en el plano");
  const swapped = await renderShot(dir, 3, { turn_id: "T005", speaker: "A", kind: "estudio_quieto", people: ["A", "B"], start: 0, end: 1, reason: "" }, 25, { speakerMatte: A, listenerMatte: B }, { ...o, swap: true });
  assert.ok(blob(swapped, 0.5, W, isA).x > W / 2 && blob(swapped, 0.5, W, isB).x < W / 2, "con «Invertir posiciones», A a la derecha y B a la izquierda (igual que en el resto del episodio)");
  // 9:16: pantalla dividida como el plano general (A arriba, B abajo), caras grandes.
  const vf = frameFor("9:16", true);
  const vq = await renderShot(dir, 4, { turn_id: "T007", speaker: "A", kind: "estudio_quieto", people: ["A", "B"], start: 0, end: 1, reason: "" }, 25, { speakerMatte: A, listenerMatte: B }, { ...o, frame: vf });
  const va = blob(vq, 0.5, vf.w, isA), vb = blob(vq, 0.5, vf.w, isB);
  const rows = va.buf.length / 3 / vf.w;
  assert.ok(va.n > 50 && vb.n > 50 && va.y < rows / 2 && vb.y > rows / 2, `9:16: A arriba y B abajo (${va.y.toFixed(0)} / ${vb.y.toFixed(0)} de ${rows})`);
});

test("render del plano fijo: no es un fotograma congelado (cámara sutil) ni un corte; dura exactamente lo pedido", { timeout: 300_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "p30-quieto-mov-"));
  const { A, B } = await people(dir);
  const { renderShot, frameFor } = await import("./compose");
  const o = { set: "calido" as const, frame: frameFor("16:9", true), swap: false, small: true, fade: false };
  const frames = 25 * 6;
  const quiet = await renderShot(dir, 1, { turn_id: "T002", speaker: "A", kind: "estudio_quieto", people: ["A", "B"], start: 0, end: 6, reason: "" }, frames, { speakerMatte: A, listenerMatte: B }, o);
  const n = Number(spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", quiet], { encoding: "utf8" }).stdout.trim());
  assert.equal(n, frames, "el plano dura exactamente los fotogramas del turno (sin desfase de audio)");
  const a = blob(quiet, 0.3, 640, () => true).buf, b = blob(quiet, 5.5, 640, () => true).buf;
  let changed = 0; for (let i = 0; i + 2 < a.length; i += 3) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) changed++;
  const share = changed / (a.length / 3);
  assert.ok(share > 0.005, `la cámara se mueve un poco (${(share * 100).toFixed(2)} % del cuadro cambia en 5 s)`);
  assert.ok(share < 0.6, "movimiento sutil, no un corte");
});

test("episodio simulado «Solo estudio» 16:9: alternancia avatar ↔ plano fijo por hablante, frecuencia del usuario intacta, sin huecos y duración de video = audio", { timeout: 600_000 }, async () => {
  const s = spec("16:9");
  const providers = mockProviders({ tonesOnly: true });
  const dir = await mkdtemp(path.join(tmpdir(), "p30-quieto-alt-"));
  const r = await runEpisode(s, { owner: "u1", episode: "ep-alt", dir, providers, ledger: new MemoryLedger(), guard: new MemoryRunGuard(), authorizedUsd: 5, small: true });
  const turnShots = r.plan.shots.filter((x) => x.turn_id);
  // Alternancia: con frecuencia 0,5 cada hablante alterna avatar y plano fijo (el primero de cada uno, con avatar).
  for (const who of ["A", "B"] as const) {
    const seq = turnShots.filter((x) => x.speaker === who).map((x) => (AVATAR.has(x.kind) ? "avatar" : x.kind));
    seq.forEach((k, i) => assert.equal(k, i % 2 === 0 ? "avatar" : "estudio_quieto", `${who}: turno ${i + 1} → ${k} (${seq.join(", ")})`));
  }
  assert.equal(turnShots.filter((x) => x.kind === "transicion").length, 0, "ningún turno con el estudio vacío");
  // La frecuencia elegida (0,5) no cambia: la mitad de los turnos con avatar, y un clip pagado por cada uno.
  const avatarTurns = turnShots.filter((x) => AVATAR.has(x.kind)).length;
  assert.equal(avatarTurns, Math.ceil(turnShots.filter((x) => x.speaker === "A").length / 2) + Math.ceil(turnShots.filter((x) => x.speaker === "B").length / 2));
  assert.equal(providers.calls.avatar.length, avatarTurns, "ningún clip de HeyGen extra");
  // Continuidad temporal: planos contiguos, sin huecos ni solapes.
  for (let i = 1; i < r.plan.shots.length; i++) assert.ok(Math.abs(r.plan.shots[i].start - r.plan.shots[i - 1].end) < 1e-6, `hueco entre planos ${i - 1} y ${i}`);
  // Duración: el MP4 dura lo mismo que la voz (±0,2 s) y el último plano termina con el audio.
  const vdur = Number(spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", r.mp4!], { encoding: "utf8" }).stdout.trim());
  const adur = Number(spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0", r.mp4!], { encoding: "utf8" }).stdout.trim());
  assert.ok(Math.abs(vdur - adur) <= 0.2, `video ${vdur.toFixed(2)} s vs audio ${adur.toFixed(2)} s`);
  assert.ok(Math.abs(r.durationSeconds - adur) <= 0.2);
});

test("duración pedida vs real: el guion de la prueba real (2 min pedidos) se estimaba en ~1 min y duró 54 s → aviso de guion corto, sin bloquear", async () => {
  const { estimateMinutes, durationFit, shortScriptNotice } = await import("./wizard");
  const real = [
    "Valeria Montclair: Bienvenidos a este episodio corto. Hoy hablamos de los sumerios y de la escritura más antigua que conocemos.",
    "Víctor Albarrán: Gracias, Valeria. Hace más de cinco mil años, en Mesopotamia, empezaron a marcar tablillas de arcilla con un punzón.",
    "Valeria Montclair: ¿Y qué escribían en esas tablillas? Imagino que historias de dioses y reyes.",
    "Víctor Albarrán: Sorprende, pero casi todo eran cuentas: cebada, ovejas, salarios y contratos. La escritura nació para administrar.",
    "Valeria Montclair: Entonces la contabilidad llegó antes que la literatura.",
    "Víctor Albarrán: Exacto. Siglos después aparecieron leyes, cartas y relatos como la epopeya de Gilgamesh.",
    "Valeria Montclair: Una idea práctica que terminó cambiando la historia. Gracias, Víctor.",
    "Víctor Albarrán: Gracias a ti, Valeria. Nos escuchamos en el próximo episodio.",
  ].join("\n");
  const est = estimateMinutes(real) * 60;
  // Episodio real ba27b6f7: 54 s. La estimación (~60 s) queda a ≤ 15 % del real; lo que fallaba era el objetivo pedido (120 s).
  assert.ok(Math.abs(est - 54) / 54 <= 0.15, `estimado ${est.toFixed(1)} s vs real 54 s`);
  assert.equal(durationFit(real, 2), "corto");
  const notice = shortScriptNotice(real, 2);
  assert.ok(notice && /unos 1[.,]0 min/.test(notice) && /pediste 2 min/.test(notice) && /no se rellena/.test(notice), String(notice));
  assert.equal(shortScriptNotice(real, 1), null, "con 1 min pedido no hay aviso");
  assert.equal(shortScriptNotice("", 5), null, "sin guion no hay aviso");
  // Aviso, no bloqueo: la pantalla de Contenido sigue sin errores por ser corto.
  const { screenErrors, defaultDraft } = await import("./wizard");
  const d = { ...defaultDraft(), modality: "dialogo" as const, mode: "dialogo" as const, count: 2 as const, title: "x", topic: "sumerios", script: real, minutes: 2 };
  assert.ok(!screenErrors(d, 1, { unavailableVoices: [], providers: [] }).some((e) => /corto|dura/.test(e)), "no bloquea «Siguiente»");
});

test("dos planos fijos seguidos son UNA toma continua: la cámara sigue donde iba y no hay fundido a negro entre ellos", { timeout: 300_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "p30-quieto-racha-"));
  const { A, B } = await people(dir);
  const { renderShot, frameFor } = await import("./compose");
  const o = { set: "calido" as const, frame: frameFor("16:9", true), swap: false, small: true, fade: true };
  const F = 100;
  const one = await renderShot(dir, 1, { turn_id: "T003", speaker: "A", kind: "estudio_quieto", people: ["A", "B"], start: 0, end: 4, reason: "" }, F, { speakerMatte: A, listenerMatte: B, quietOffsetFrames: 0, quietJoinNext: true }, o);
  const two = await renderShot(dir, 2, { turn_id: "T004", speaker: "B", kind: "estudio_quieto", people: ["A", "B"], start: 4, end: 8, reason: "" }, F, { speakerMatte: B, listenerMatte: A, quietOffsetFrames: F, quietJoinPrev: true }, o);
  const restart = await renderShot(dir, 3, { turn_id: "T004", speaker: "B", kind: "estudio_quieto", people: ["A", "B"], start: 4, end: 8, reason: "" }, F, { speakerMatte: B, listenerMatte: A, quietJoinPrev: true }, o);
  const frameAt = (f: string, n: number) => { const raw = `${f}.${n}.rgb`; spawnSync("ffmpeg", ["-y", "-v", "error", "-i", f, "-vf", `select=eq(n\\,${n}),scale=320:-2,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", raw]); return readFileSync(raw); };
  const diff = (a: Buffer, b: Buffer) => { let d = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) d += Math.abs(a[i] - b[i]); return d / Math.min(a.length, b.length); };
  const last1 = frameAt(one, F - 1), first2 = frameAt(two, 0), firstR = frameAt(restart, 0);
  const mean = (b: Buffer) => b.reduce((n, x) => n + x, 0) / b.length;
  assert.ok(mean(last1) > 40 && mean(first2) > 40, `sin fundido a negro en el corte: brillo ${mean(last1).toFixed(0)} / ${mean(first2).toFixed(0)}`);
  assert.ok(diff(last1, first2) < diff(last1, firstR), `la toma sigue (dif ${diff(last1, first2).toFixed(2)}) en vez de reiniciar el encuadre (dif ${diff(last1, firstR).toFixed(2)})`);
  assert.ok(diff(last1, first2) < 3, `corte imperceptible entre planos fijos: ${diff(last1, first2).toFixed(2)}`);
});
