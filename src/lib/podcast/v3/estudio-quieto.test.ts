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
