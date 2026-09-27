/**
 * Documental en inglés preparado (content/long-form/ocean-deep-001) y los
 * cambios aditivos que necesita: rótulos en el idioma del video, muestras de
 * varios beats iniciales y coherencia guion ↔ storyboard. Sin red ni gasto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pendingLabel, provenanceLabel } from "../../../../remotion/long-form-card-fit";
import { leadingBeats } from "./sample-manifest";
import { loadScriptFromFile } from "./script-loader";
import { loadStoryboardFromFile } from "./storyboard-loader";
import { findMusicBed } from "../../tts/music-beds";

const SCRIPT = "content/long-form/ocean-deep-001/ocean-script-001.json";
const STORYBOARD = "content/long-form/ocean-deep-001/ocean-storyboard-001.json";

test("rótulos en pantalla: inglés para un video en inglés; español por defecto (sin cambios)", () => {
  assert.equal(provenanceLabel("ai_recreation"), "Recreación IA");
  assert.equal(provenanceLabel("ai_recreation", "en"), "AI recreation");
  assert.equal(provenanceLabel("stock_illustrative", "en"), null);
  assert.equal(pendingLabel(), "Material pendiente");
  assert.equal(pendingLabel("en"), "Pending material");
});

test("muestra de varios beats: solo los primeros del guion, en orden y sin huecos", () => {
  const beats = [{ id: "b1" }, { id: "b2" }, { id: "b3" }];
  assert.deepEqual(leadingBeats(beats, ["b1"]).map((b) => b.id), ["b1"]);
  assert.deepEqual(leadingBeats(beats, ["b1", "b2", "b3"]).map((b) => b.id), ["b1", "b2", "b3"]);
  assert.throws(() => leadingBeats(beats, ["b2"]), /primeros del guion/);
  assert.throws(() => leadingBeats(beats, ["b1", "b3"]), /primeros del guion/);
  assert.throws(() => leadingBeats(beats, []), /no declara/);
});

test("guion del océano: inglés, 1.750–1.950 palabras (≈10 min al ritmo medido de Brian), cada afirmación con fuente o marcada como inferencia", () => {
  const raw = JSON.parse(readFileSync(SCRIPT, "utf8")) as {
    meta: { language: string; wordCount: number };
    researchPack: { sources: { id: string }[] };
    beats: { claims: { support: string; sourceIds: string[] }[] }[];
  };
  assert.equal(raw.meta.language, "en");
  assert.ok(raw.meta.wordCount >= 1750 && raw.meta.wordCount <= 1950, `palabras: ${raw.meta.wordCount}`);
  const ids = new Set(raw.researchPack.sources.map((s) => s.id));
  for (const claim of raw.beats.flatMap((b) => b.claims)) {
    assert.notEqual(claim.support, "unverified");
    if (claim.support === "sourced") assert.ok(claim.sourceIds.length > 0);
    for (const id of claim.sourceIds) assert.ok(ids.has(id), `fuente desconocida: ${id}`);
  }
  // Nunca la cifra desactualizada de la página archivada (">80% unmapped/unexplored").
  assert.doesNotMatch(readFileSync(SCRIPT, "utf8").replace(/"outdatedFigureAvoided"[^\n]*\n/, "").replace(/"notes": "Current page[^\n]*\n/, ""), /eighty percent|80% unmapped/i);
});

test("storyboard del océano: cubre cada beat del guion, recreaciones IA marcadas y licencias explícitas", () => {
  const script = loadScriptFromFile(SCRIPT);
  const storyboard = loadStoryboardFromFile(STORYBOARD);
  for (const beat of script.beats) assert.ok((storyboard.shotsByBeatId.get(beat.id) ?? []).length > 0, `sin planos: ${beat.id}`);
  const raw = JSON.parse(readFileSync(STORYBOARD, "utf8")) as {
    shots: { shotId: string; hybridClassification: string; aiGenerated: boolean; licensing: { status: string }; queryOrPrompt: string; firstMinute?: boolean; estimatedCostUsd: number }[];
  };
  for (const shot of raw.shots) {
    assert.ok(shot.licensing.status.length > 20, `licencia sin detallar: ${shot.shotId}`);
    assert.equal(shot.aiGenerated, shot.hybridClassification === "AI_RECREATION", shot.shotId);
    if (shot.aiGenerated) assert.match(shot.licensing.status, /AI illustration|AI animation/);
    // Material de MBARI: con derechos reservados, nunca como fuente de imagen.
    assert.doesNotMatch(shot.queryOrPrompt, /mbari\.org/i, shot.shotId);
  }
  const firstMinute = raw.shots.filter((s) => s.firstMinute);
  assert.ok(firstMinute.length > 0 && firstMinute.every((s) => s.shotId.startsWith("b1-")));
});

test("música del documental: fondos propios existentes (sin pistas de terceros)", () => {
  for (const id of ["atomivid-suspense-a-v1", "atomivid-documentary-b-v1"]) {
    const bed = findMusicBed(id);
    assert.ok(bed, id);
    assert.equal(bed.attribution, null);
  }
});

test("mapas del océano: costas reales, proporción correcta y marcadores dentro", async () => {
  const { MAP_LAND, MAP_LAND_SOURCE, mapLandIssue } = await import("../../../../remotion/map-land");
  const { realGraphicSpecProvider } = await import("./real-graphics");
  assert.match(MAP_LAND_SOURCE, /Natural Earth/);
  const raw = JSON.parse(readFileSync(STORYBOARD, "utf8")) as { shots: { shotId: string; assetType: string; visualIntent: string }[] };
  const maps = raw.shots.filter((s) => s.assetType === "map");
  assert.equal(maps.length, 6);
  for (const shot of maps) {
    const spec = realGraphicSpecProvider({ id: shot.shotId, type: "map", captionText: shot.visualIntent } as never);
    assert.ok(spec && spec.kind === "map" && spec.landKey, shot.shotId);
    const region = MAP_LAND[spec.landKey];
    assert.equal(mapLandIssue(spec.landKey, spec.bounds), null);
    assert.ok(region.land.length > 0, `${shot.shotId}: sin tierra`);
    // Caja 2:1 con proporción real (equirectangular local): lonSpan·cos(lat) ≈ 2·latSpan.
    const b = region.bounds;
    const midLat = ((b.minLat + b.maxLat) / 2) * (Math.PI / 180);
    const ratio = ((b.maxLon - b.minLon) * Math.cos(midLat)) / (b.maxLat - b.minLat);
    assert.ok(ratio > 1.6 && ratio < 2.4, `${shot.shotId}: proporción ${ratio.toFixed(2)}`);
    for (const m of spec.markers) {
      assert.ok(m.longitude > b.minLon && m.longitude < b.maxLon && m.latitude > b.minLat && m.latitude < b.maxLat, `${shot.shotId}: ${m.label} fuera`);
    }
    // Ningún tramo de costa cruza el mapa de lado a lado (defecto del antimeridiano).
    const width = b.maxLon - b.minLon;
    for (const ring of region.land.flat()) {
      for (let i = 1; i < ring.length; i++) {
        const dx = Math.abs(ring[i][0] - ring[i - 1][0]);
        const onEdge = [b.minLon, b.maxLon].some((e) => Math.abs(ring[i][0] - e) < width * 0.03 && Math.abs(ring[i - 1][0] - e) < width * 0.03);
        const alongBorder = [b.minLat, b.maxLat].some((e) => Math.abs(ring[i][1] - e) < (b.maxLat - b.minLat) * 0.03 && Math.abs(ring[i - 1][1] - e) < (b.maxLat - b.minLat) * 0.03);
        assert.ok(dx < width * 0.5 || onEdge || alongBorder, `${shot.shotId}: segmento de ${dx.toFixed(1)}° a ${ring[i][1]}°`);
      }
    }
  }
});

test("muestra: una tarjeta de texto sin size «large» se rechaza", async () => {
  const { validateSampleManifest } = await import("./sample-manifest");
  const manifest = JSON.parse(readFileSync("docs/quality/ocean-deep-001/minute1-manifest.draft.json", "utf8"));
  const codes = (m: unknown) => validateSampleManifest(m as never, [], 0).map((i) => i.code);
  assert.ok(!codes(manifest).includes("card_size"));
  const small = structuredClone(manifest);
  const card = small.scenes.find((s: { source: { kind: string } }) => s.source.kind === "graphic");
  delete card.source.spec.size;
  assert.ok(codes(small).includes("card_size"));
});

test("subtítulos con resaltado por palabra: tiempos propios por bloque y palabra activa sin saltos", async () => {
  const { withCaptionWords } = await import("./scene-captions");
  const { activeWordIndex } = await import("../../../../remotion/LongFormDoc");
  const words = [
    { text: "A", startSeconds: 0, endSeconds: 0.1 },
    { text: "light", startSeconds: 0.2, endSeconds: 0.4 },
    { text: "switches", startSeconds: 0.5, endSeconds: 0.8 },
    { text: "on,", startSeconds: 0.9, endSeconds: 1.3 },
  ];
  const captions = [
    { text: "A light", startSeconds: 0, endSeconds: 0.4 },
    { text: "switches on,", startSeconds: 0.5, endSeconds: 1.3 },
  ];
  const out = withCaptionWords(captions, words);
  assert.deepEqual(out[0].words?.map((w) => w.text), ["A", "light"]);
  assert.deepEqual(out[1].words?.map((w) => w.text), ["switches", "on,"]);
  // Un bloque cuyo texto no coincide con las palabras se deja tal cual (sin resaltado, nunca desalineado).
  assert.equal(withCaptionWords([{ text: "other text", startSeconds: 0, endSeconds: 1 }], words)[0].words, undefined);
  assert.equal(activeWordIndex(out[1].words!, 0.45), -1);
  assert.equal(activeWordIndex(out[1].words!, 0.85), 0); // entre palabras se mantiene la anterior
  assert.equal(activeWordIndex(out[1].words!, 1.0), 1);
});
