import { test } from "node:test";
import assert from "node:assert/strict";
import { FORBIDDEN_SCORING_TERMS, metadataMatch, sceneVisualIntent } from "./scene-visual-intent";
import { buildFallbackQuery, createFootageSelectionState, selectFootageForScene } from "./footage-select";
import { fixtureFootageProvider, SAMPLE_SCENES } from "./footage-intent.fixture";
import type { FootageCandidate } from "@/lib/providers/types";

const auditClip = (sourceId: string, description: string): FootageCandidate => ({
  sourceId, description, url: `https://fixture.test/${sourceId}.mp4`, mediaType: "video",
  mimeType: "video/mp4", extension: "mp4", width: 1080, height: 1920, durationSeconds: 6,
});

test("regresión: la narración no añade un veto emocional a una apertura válida", async () => {
  const provider = fixtureFootageProvider({ "phone recording": [auditClip("hook", "tired person recording phone")] });
  const out = await selectFootageForScene({ provider, concepts: ["phone recording"],
    narration: "¿Te falta confianza al grabar?", isOpening: true,
    minimumDurationSeconds: 3, state: createFootageSelectionState() });
  assert.equal(out.sourceId, "hook");
  assert.equal(out.openingRelevance?.accepted, true);
});

test("regresión: evolución natural y hábitos animales no son superación o gimnasio", () => {
  assert.equal(sceneVisualIntent("La evolución de las aves transformó sus alas.", ["bird evolution wings"]), null);
  assert.equal(sceneVisualIntent("Los hábitos nocturnos de los búhos.", ["owl hunting night"]), null);
  assert.equal(sceneVisualIntent("La luz entra por la ventana.", ["window sunlight"]), null);
});

test("regresión: un resultado sin relación no evita buscar una alternativa pertinente", async () => {
  const provider = fixtureFootageProvider({
    "confident professional walking city": [auditClip("fog", "foggy landscape aerial")],
    "business walking": [auditClip("fit", "confident person in suit walking office")],
  });
  const out = await selectFootageForScene({ provider, concepts: ["new life"], narration: "Camina con confianza",
    minimumDurationSeconds: 3, state: createFootageSelectionState() });
  assert.equal(out.sourceId, "fit");
});

test("regresión: el respaldo contradictorio no se anuncia como coincidencia", async () => {
  const provider = fixtureFootageProvider({});
  provider.searchImageCandidates = async () => [{ ...auditClip("sad", "sad tired person in suit walking office"), mediaType: "image", mimeType: "image/jpeg", extension: "jpg" }];
  const out = await selectFootageForScene({ provider, concepts: ["new life"], narration: "Camina con confianza",
    minimumDurationSeconds: 3, state: createFootageSelectionState() });
  assert.equal(out.metadataMatch, "none");
});

test("regresión: una foto contradictoria no gana a una foto coherente por resolución", async () => {
  const provider = fixtureFootageProvider({});
  provider.searchImageCandidates = async () => [
    { ...auditClip("sad", "sad confident professional in suit walking city upright"), mediaType: "image", mimeType: "image/jpeg", extension: "jpg" },
    { ...auditClip("fit", "person walking city"), mediaType: "image", width: 720, height: 1280, mimeType: "image/jpeg", extension: "jpg" },
  ];
  const out = await selectFootageForScene({ provider, concepts: ["new life"], narration: "Camina con confianza",
    minimumDurationSeconds: 3, state: createFootageSelectionState() });
  assert.equal(out.sourceId, "fit");
});

const pick = async (scene: (typeof SAMPLE_SCENES)[number], withNarration: boolean) => {
  const provider = fixtureFootageProvider();
  const out = await selectFootageForScene({ provider, concepts: scene.concepts, minimumDurationSeconds: 3, state: createFootageSelectionState(), narration: withNarration ? scene.text : undefined });
  return { out, calls: provider.calls };
};

test("cierre de Hans: transformación + caminar con confianza → criterios observables de confianza profesional", () => {
  const intent = sceneVisualIntent(SAMPLE_SCENES[0].text, SAMPLE_SCENES[0].concepts)!;
  assert.equal(intent.id, "professional_confidence");
  assert.ok(intent.facets.wardrobe!.includes("suit") && intent.facets.action!.includes("walking") && intent.facets.setting!.includes("office"));
  assert.ok(intent.facets.posture!.includes("upright"));
});

test("cierre: antes elegía «persona triste en la ventana»; ahora el plano ejecutivo caminando por la ciudad", async () => {
  const before = await pick(SAMPLE_SCENES[0], false);
  assert.equal(before.out.sourceId, "px-sad-window");
  const after = await pick(SAMPLE_SCENES[0], true);
  assert.equal(after.out.sourceId, "px-exec-walk");
  assert.equal(after.out.metadataMatch, "metadata");
  assert.deepEqual([...after.out.metadataFacets!].sort(), ["action", "emotion", "setting", "wardrobe"]);
  assert.match(after.out.reason, /coincidencia textual, no verificación visual/);
});

test("la señal contradictoria resta (party/sad en una escena de confianza)", () => {
  const intent = sceneVisualIntent("camina con confianza")!;
  assert.ok(metadataMatch("people dancing at party night", intent, "x").points < 0);
  assert.ok(metadataMatch("sad person looking out window", intent, "x").points < 0);
});

test("las búsquedas siguen acotadas: ≤3 consultas de video + 1 reformulación + ≤3 de imagen por plano", async () => {
  for (const s of SAMPLE_SCENES) {
    const { calls } = await pick(s, true);
    assert.ok(calls.filter((c) => c.startsWith("video:")).length <= 4, calls.join(","));
    assert.ok(calls.filter((c) => c.startsWith("image:")).length <= 3, calls.join(","));
  }
});

test("la reformulación conserva acción + entorno (no «las 2 primeras palabras»)", () => {
  const intent = sceneVisualIntent("camina con paso firme")!;
  assert.equal(buildFallbackQuery("new life change", intent), "business walking");
  assert.equal(buildFallbackQuery("new life change"), "new life");
});

test("reformulación con criterios: si la consulta enriquecida no trae nada útil, el fallback también puntúa por criterios", async () => {
  const provider = fixtureFootageProvider({
    "confident professional walking city": [],
    "new life change": [{ url: "u", sourceId: "x", mediaType: "video", mimeType: "video/mp4", extension: "mp4", width: 1080, height: 1920, durationSeconds: 6, description: "sad person crying alone" }],
    "self improvement journey": [],
    "business walking": [{ url: "u2", sourceId: "y", mediaType: "video", mimeType: "video/mp4", extension: "mp4", width: 1080, height: 1920, durationSeconds: 6, description: "business people walking in office corridor" }],
  });
  const out = await selectFootageForScene({ provider, concepts: SAMPLE_SCENES[0].concepts, minimumDurationSeconds: 3, state: createFootageSelectionState(), narration: SAMPLE_SCENES[0].text });
  assert.equal(out.sourceId, "y");
  assert.equal(out.usedFallbackQuery, true);
  assert.equal(out.queryUsed, "business walking");
});

test("sin material adecuado: se usa el mejor técnico, sin revisión manual, y se marca metadataMatch=none", async () => {
  const provider = fixtureFootageProvider({ "confident professional walking city": [{ url: "u", sourceId: "z", mediaType: "video", mimeType: "video/mp4", extension: "mp4", width: 1080, height: 1920, durationSeconds: 6, description: "foggy landscape aerial" }] });
  const out = await selectFootageForScene({ provider, concepts: ["new life change"], minimumDurationSeconds: 3, state: createFootageSelectionState(), narration: "camina con confianza" });
  assert.equal(out.sourceId, "z");
  assert.equal(out.metadataMatch, "none");
});

test("sin descripción del proveedor la pertinencia queda «unchecked», nunca se inventa", async () => {
  const provider = fixtureFootageProvider({ "confident professional walking city": [{ url: "u", sourceId: "n", mediaType: "video", mimeType: "video/mp4", extension: "mp4", width: 1080, height: 1920, durationSeconds: 6 }] });
  const out = await selectFootageForScene({ provider, concepts: ["x"], minimumDurationSeconds: 3, state: createFootageSelectionState(), narration: "camina con confianza" });
  assert.equal(out.metadataMatch, "unchecked");
});

test("nunca se puntúa atractivo físico ni identidad de género", () => {
  const intent = sceneVisualIntent("camina con confianza")!;
  const all = [...Object.values(intent.facets).flat(), intent.query, intent.fallbackQuery, ...intent.contradicts].map((t) => t!.toLowerCase());
  for (const banned of FORBIDDEN_SCORING_TERMS) assert.ok(!all.some((t) => t.split(/\s+/).includes(banned)), banned);
  const a = metadataMatch("confident man in suit walking city", intent, "x").points;
  const b = metadataMatch("confident woman in suit walking city", intent, "x").points;
  const c = metadataMatch("confident person in suit walking city", intent, "x").points;
  const d = metadataMatch("beautiful confident person in suit walking city", intent, "x").points;
  assert.equal(a, b); assert.equal(b, c); assert.equal(c, d);
});

test("escena sin intención clara: mismas consultas que antes (sin regla, sin consulta enriquecida)", async () => {
  const before = await pick(SAMPLE_SCENES[3], false);
  const after = await pick(SAMPLE_SCENES[3], true);
  assert.deepEqual(after.calls, before.calls);
  assert.equal(sceneVisualIntent(SAMPLE_SCENES[3].text, SAMPLE_SCENES[3].concepts), null);
});

test("la apertura conserva su consulta y su regla de pertinencia (sin consulta enriquecida)", async () => {
  const provider = fixtureFootageProvider();
  await selectFootageForScene({ provider, concepts: SAMPLE_SCENES[0].concepts, minimumDurationSeconds: 3, state: createFootageSelectionState(), narration: SAMPLE_SCENES[0].text, isOpening: true }).catch(() => undefined);
  assert.equal(provider.calls[0], "video:new life change");
});

test("sólo hay video contradictorio y ninguna imagen: no falla (como antes), usa el mejor técnico y lo marca", async () => {
  const provider = fixtureFootageProvider({ "confident professional walking city": [{ url: "u", sourceId: "only", mediaType: "video", mimeType: "video/mp4", extension: "mp4", width: 1080, height: 1920, durationSeconds: 6, description: "sad tired person crying sleeping" }] });
  const out = await selectFootageForScene({ provider, concepts: ["x"], minimumDurationSeconds: 3, state: createFootageSelectionState(), narration: "camina con confianza" });
  assert.equal(out.sourceId, "only");
  assert.equal(out.metadataMatch, "none");
});
