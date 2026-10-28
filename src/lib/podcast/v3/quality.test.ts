/**
 * Podcast 3.0 — calidad audiovisual a partir de la prueba real del 2026-10-28 (episodio 0a482791, Hans + Valeria):
 * 1) Valeria nunca habló a cámara: un único acumulador de frecuencia daba todas las apariciones al mismo hablante cuando
 *    la conversación alterna A/B; 2) las búsquedas de imágenes usaban palabras sueltas del turno («salida» → letrero de un
 *    estacionamiento). Sin red ni ffmpeg (el recorte de la cara se prueba en render.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planEpisode, planIssues as planIssuesOf, salientTerms, type VisualAsset } from "./editorial";
import { parseLabeledScript } from "./script";
import { gatherAssets, type ImageProvider } from "./pipeline";

const P2 = "Hans: Valeria, ¿de verdad un cometa puede venir de otra estrella?\nValeria: Sí, Hans. Lo sabemos por su velocidad: ningún objeto atado al Sol viaja tan rápido.\nHans: ¿Y no podría ser un error de medición?\nValeria: Lo siguieron varios observatorios durante semanas, y todos los datos coinciden.\nHans: Entonces, ¿qué nos cuenta de su origen?\nValeria: Que los sistemas planetarios expulsan restos, y algunos viajan millones de años entre las estrellas.\nHans: ¿Volveremos a verlo?\nValeria: No. Va de salida, y nunca más regresará.";
const turns = parseLabeledScript(P2)!.turns;
const avatarKinds = new Set(["avatar_a", "avatar_b", "two_shot", "over_shoulder"]);
const plan = (freq: number) => planEpisode({ mode: "dialogo", turns, assets: [], avatarFrequency: freq, avatarMaxSeconds: 10, recreations: false, hasAvatar: { A: true, B: true }, introSeconds: 3 });

test("diálogo A/B alternado con frecuencia 0.5: los DOS participantes hablan a cámara (antes: solo A)", () => {
  const speakers = plan(0.5).shots.filter((s) => avatarKinds.has(s.kind)).map((s) => s.speaker);
  assert.ok(speakers.includes("A"), "A aparece");
  assert.ok(speakers.includes("B"), "B (Valeria) aparece hablando a cámara");
  assert.equal(speakers.filter((s) => s === "A").length, speakers.filter((s) => s === "B").length, "reparto equilibrado: 4 turnos de cada uno, ~50 % de cada uno");
});

test("frecuencia por participante: 1 → todos los turnos con avatar; 0 → ninguno; 0.25 → ~1 de cada 4 turnos de cada uno", () => {
  assert.equal(plan(1).shots.filter((s) => avatarKinds.has(s.kind)).length, turns.length);
  assert.equal(plan(0).shots.filter((s) => avatarKinds.has(s.kind)).length, 0);
  const q = plan(0.25).shots.filter((s) => avatarKinds.has(s.kind)).map((s) => s.speaker);
  assert.deepEqual([q.filter((s) => s === "A").length, q.filter((s) => s === "B").length], [1, 1]);
});

test("un participante sin avatar no consume apariciones del otro (la del otro sigue su propio ritmo)", () => {
  const p = planEpisode({ mode: "dialogo", turns, assets: [], avatarFrequency: 0.5, avatarMaxSeconds: 10, recreations: false, hasAvatar: { A: true, B: false } });
  const sp = p.shots.filter((s) => avatarKinds.has(s.kind)).map((s) => s.speaker);
  assert.ok(sp.length >= 2 && sp.every((s) => s === "A"));
});

test("búsquedas ancladas: tema → título (sin cifras) → palabras repetidas del guion; nunca una palabra suelta del turno", async () => {
  assert.deepEqual(salientTerms("Cometa interestelar", []), ["cometa", "interestelar"]);
  assert.deepEqual(salientTerms("", [], 2, "El cometa 3I/ATLAS 2026"), ["cometa", "atlas"], "sin tema: el título, sin cifras");
  assert.deepEqual(salientTerms("", ["la luna y el cometa", "la luna llena"]), ["luna"], "sin tema ni título: palabras repetidas del guion");
  const queries: string[] = [];
  const images: ImageProvider = { name: "x", label: "mock", recreateUsd: 0, async search(q: string) { queries.push(q); return [] as VisualAsset[]; }, async fetch() {} } as unknown as ImageProvider;
  await gatherAssets(turns, images, "Prueba real P2", false, "cometa interestelar");
  assert.ok(queries.length > 0 && queries.every((q) => q.startsWith("cometa interestelar")), JSON.stringify(queries));
  assert.ok(queries.some((q) => q.includes("salida")), "la palabra del turno sigue, pero acompañada del tema");
  assert.ok(!queries.includes("salida nunca regresara"), "la búsqueda literal que trajo el letrero de estacionamiento ya no existe");
});

test("turnos sin imagen propia usan una imagen NO usada del tema, no un plano vacío (P2 real: 4 planos vacíos de 2-5 s)", async () => {
  // Imágenes como las que trae la búsqueda del ancla sola: etiquetadas con el tema, sin palabras de los turnos.
  const pool: VisualAsset[] = Array.from({ length: 8 }, (_, i) => ({ id: `px-${i}`, query: "cometa interestelar", kind: "foto" as const, tags: ["cometa", "interestelar", "space"] }));
  const at = (topicTerms?: string[]) => planEpisode({ mode: "dialogo", turns, assets: pool, topicTerms, avatarFrequency: 0.25, avatarMaxSeconds: 10, recreations: false, hasAvatar: { A: true, B: true }, introSeconds: 3 });
  const withTopic = at(["cometa", "interestelar"]);
  const nonAvatar = withTopic.shots.filter((s) => s.turn_id && !avatarKinds.has(s.kind));
  assert.ok(nonAvatar.length >= 4, "con frecuencia 0.25 la mayoría de turnos no llevan avatar");
  assert.equal(nonAvatar.filter((s) => s.kind === "transicion").length, 0, "ningún turno queda en plano vacío mientras haya imágenes del tema");
  assert.equal(new Set(withTopic.assetsUsed).size, withTopic.assetsUsed.length, "sin repetir imágenes");
  assert.deepEqual(planIssuesOf(withTopic), []);
  // Sin términos del tema, el comportamiento anterior: nada ajeno, transición.
  assert.ok(at(undefined).shots.some((s) => s.kind === "transicion"));
  // Agotadas las imágenes del tema, el resto vuelve a transición (no repite).
  const scarce = planEpisode({ mode: "dialogo", turns, assets: pool.slice(0, 1), topicTerms: ["cometa"], avatarFrequency: 0, avatarMaxSeconds: 10, recreations: false, hasAvatar: { A: true, B: true } });
  assert.equal(scarce.assetsUsed.length, 1);
  // La búsqueda del ancla sola pide el fondo del tema (8 imágenes).
  const calls: { q: string; limit?: number }[] = [];
  const images = { name: "x", label: "mock", async search(q: string, limit?: number) { calls.push({ q, limit }); return [] as VisualAsset[]; }, async fetch() {} } as unknown as ImageProvider;
  await gatherAssets(turns, images, "Prueba real P2", false, "cometa interestelar");
  assert.deepEqual(calls[0], { q: "cometa interestelar", limit: 8 });
});
