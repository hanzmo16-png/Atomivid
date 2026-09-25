import { test } from "node:test";
import assert from "node:assert/strict";
import { fitLargeCard, provenanceLabel, LARGE_CARD } from "../../../../remotion/long-form-card-fit";
import { assertApprovalReady, cardFitIssues, RenderApprovalError } from "./render-approval";
import { cutsThroughWord, snapBoundaryToSpeech } from "./scene-anchoring";
import { requiredClipSeconds, validateSampleManifest, blockingIssues, type SampleManifest, type SampleScene } from "./sample-manifest";
import { buildDataMapSvg, routeLengthKm } from "./data-map";
import type { LongFormShotScene } from "../../../../remotion/LongFormDoc";

const words = [
  { text: "Imagina", startSeconds: 0, endSeconds: 0.4 },
  { text: "cavar,", startSeconds: 0.45, endSeconds: 0.9 },
  { text: "rodeado", startSeconds: 1.3, endSeconds: 1.8 },
  { text: "de", startSeconds: 1.85, endSeconds: 1.95 },
  { text: "mosquitos.", startSeconds: 2.0, endSeconds: 2.6 },
];

test("tarjeta grande: tamaños mínimos legibles y rechazo por desbordamiento (nunca se encoge)", () => {
  assert.ok(LARGE_CARD.TITLE_PX >= 72 && LARGE_CARD.BODY_PX >= 44);
  assert.equal(fitLargeCard("≈ 80 km", "Recorrido aproximado del canal").fits, true);
  const long = "palabra ".repeat(160);
  assert.equal(fitLargeCard("Título", long).fits, false);
  assert.equal(fitLargeCard("x".repeat(80), "").fits, false, "una palabra más ancha que la línea no cabe");
});

test("rótulo de procedencia: solo la recreación IA se rotula, y siempre", () => {
  assert.equal(provenanceLabel("ai_recreation"), "Recreación IA");
  assert.equal(provenanceLabel("archival_documentary"), null);
  assert.equal(provenanceLabel(undefined), null);
});

const media = (id: string, extra: Partial<LongFormShotScene> = {}): LongFormShotScene => ({
  id, startSeconds: 0, endSeconds: 2, asset: { kind: "media", mediaType: "image", url: "https://x/a.jpg" }, motion: "static", ...extra,
});

test("render de aprobación: bloqueado mientras haya escenas pendientes; el técnico solo las marca", () => {
  assert.doesNotThrow(() => assertApprovalReady([media("a"), media("b")]));
  assert.throws(() => assertApprovalReady([media("a"), media("b", { pending: "carencia de material pertinente" })]), (err: unknown) => {
    assert.ok(err instanceof RenderApprovalError);
    assert.deepEqual(err.issues.map((i) => i.sceneId), ["b"]);
    return true;
  });
  const card = media("c", { asset: { kind: "graphic", graphic: { kind: "text", title: "T", body: "palabra ".repeat(200), isFixture: false, size: "large" } } });
  assert.equal(cardFitIssues([card]).length, 1);
});

test("cortes alineados a la voz: al silencio más cercano, antes de la palabra siguiente, nunca dentro de una palabra", () => {
  const cut = snapBoundaryToSpeech(1.1, words);
  assert.equal(cut, +(1.3 - 0.12).toFixed(3));
  assert.equal(cutsThroughWord(cut, words), false);
  assert.equal(cutsThroughWord(1.5, words), true);
  // Sin silencio cerca: no se inventa un corte lejano.
  assert.equal(snapBoundaryToSpeech(10, words), 10);
});

const scene = (id: string, start: number, end: number, narration: string, extra: Partial<SampleScene> = {}): SampleScene => ({
  id, startSeconds: start, endSeconds: end, narration,
  source: { kind: "pexels-photo", id: Number(id.replace(/\D/g, "")) || 1 },
  provenance: "stock_illustrative", direction: { transition: { type: "cut" } },
  review: { status: "approved", relevance: "directa", note: "" }, ...extra,
});
const base = (scenes: SampleScene[]): SampleManifest => ({ requestId: "r", beats: ["beat-1"], tailSeconds: 0.4, outputPrefix: "r/samples/x", scenes, soundCues: [], missingSound: [] });

test("manifiesto de muestra: contiguo, fragmento narrado real, sin recursos repetidos, cortes fuera de palabras", () => {
  const ok = base([scene("s1", 0, 1.18, "Imagina cavar,"), scene("s2", 1.18, 3.0, "rodeado de mosquitos.")]);
  assert.deepEqual(validateSampleManifest(ok, words, 2.6), []);

  const dup = base([scene("s1", 0, 1.18, "Imagina cavar,"), scene("s2", 1.18, 3.0, "rodeado de mosquitos.", { source: { kind: "pexels-photo", id: 1 } })]);
  assert.ok(validateSampleManifest(dup, words, 2.6).some((i) => i.code === "duplicate"));

  const wrongText = base([scene("s1", 0, 1.18, "Imagina cavar,"), scene("s2", 1.18, 3.0, "otra cosa")]);
  assert.ok(validateSampleManifest(wrongText, words, 2.6).some((i) => i.code === "narration_mismatch"));

  const inWord = base([scene("s1", 0, 1.5, "Imagina cavar, rodeado"), scene("s2", 1.5, 3.0, "de mosquitos.")]);
  assert.ok(validateSampleManifest(inWord, words, 2.6).some((i) => i.code === "cut_in_word"));

  const pending = base([scene("s1", 0, 1.18, "Imagina cavar,", { review: { status: "pending", relevance: "indirecta", note: "revisar" } }), scene("s2", 1.18, 3.0, "rodeado de mosquitos.")]);
  const issues = validateSampleManifest(pending, words, 2.6);
  assert.deepEqual(issues.map((i) => i.code), ["pending_review"]);
  assert.deepEqual(blockingIssues(issues), [], "pendiente no bloquea el render técnico (sí el de aprobación)");
});

test("duración de clip requerida: desfase + escena + cola del fundido de la escena siguiente", () => {
  const scenes = [
    scene("s1", 0, 3, "a", { source: { kind: "pexels-video", id: 1 }, direction: { transition: { type: "cut" }, mediaStartSeconds: 2 } }),
    scene("s2", 3, 5, "b", { direction: { transition: { type: "dissolve", seconds: 0.8 } } }),
  ];
  assert.equal(requiredClipSeconds(scenes, 0), 2 + 3 + 0.8);
  assert.equal(requiredClipSeconds(scenes, 1), 2);
});

test("mapa de datos: la cifra narrada solo se rotula si el trazado medido concuerda", () => {
  const route: [number, number][] = [[-79.9, 9.38], [-79.52, 8.88]];
  const km = routeLengthKm(route);
  assert.ok(km > 60 && km < 75);
  const base = { bbox: [-80.5, 8.5, -79, 9.8] as [number, number, number, number], land: [], source: "test" };
  assert.equal(buildDataMapSvg({ ...base, route: { points: route, label: "≈ 70 km" }, narratedKm: Math.round(km) }).labeledKm, true);
  const off = buildDataMapSvg({ ...base, route: { points: route, label: "≈ 200 km" }, narratedKm: 200 });
  assert.equal(off.labeledKm, false);
  assert.ok(!off.svg.includes("200 km"));
});

test("dirección por defecto v3: corte salvo salto de época; cámara solo en imágenes fijas y alternada", async () => {
  const { defaultDirections, ERA_DISSOLVE_SEC } = await import("./montage-direction");
  const d = defaultDirections([
    { kind: "video", provenance: "stock_illustrative" },
    { kind: "video", provenance: "stock_illustrative" },
    { kind: "image", provenance: "archival_documentary" },
    { kind: "image", provenance: "archival_documentary" },
    { kind: "graphic" },
  ]);
  assert.deepEqual(d.map((x) => x.transition?.type), ["cut", "cut", "dissolve", "cut", "dissolve"]);
  assert.equal(d[2].transition?.seconds, ERA_DISSOLVE_SEC);
  assert.deepEqual(d.map((x) => x.camera), ["still", "still", "push", "left", "still"]);
});

test("escenas v3 dirigidas: límites a la voz, procedencia visible y carencia marcada como pendiente", async () => {
  const { directAnchoredScenes } = await import("./produce");
  const scenes: LongFormShotScene[] = [
    media("a", { startSeconds: 0, endSeconds: 1.2 }),
    { ...media("b", { startSeconds: 1.2, endSeconds: 3 }), asset: { kind: "graphic", graphic: { kind: "text", title: "t", body: "", isFixture: false, size: "large" } } },
  ];
  const out = directAnchoredScenes(scenes, [{ assetMeta: { provenance: { kind: "ai_recreation" } as never } }, { assetMeta: { gap: { reason: "sin candidato pertinente" } } }], words);
  assert.equal(out[0].endSeconds, out[1].startSeconds);
  assert.equal(out[0].endSeconds, +(1.3 - 0.12).toFixed(3));
  assert.equal(out[0].provenance, "ai_recreation");
  assert.match(out[1].pending ?? "", /carencia de material pertinente/);
  assert.equal(out[1].direction?.camera, "still");
});
