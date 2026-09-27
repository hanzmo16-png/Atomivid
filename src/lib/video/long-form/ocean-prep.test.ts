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

test("guion del océano: inglés, 1.300–1.500 palabras, cada afirmación con fuente o marcada como inferencia", () => {
  const raw = JSON.parse(readFileSync(SCRIPT, "utf8")) as {
    meta: { language: string; wordCount: number };
    researchPack: { sources: { id: string }[] };
    beats: { claims: { support: string; sourceIds: string[] }[] }[];
  };
  assert.equal(raw.meta.language, "en");
  assert.ok(raw.meta.wordCount >= 1300 && raw.meta.wordCount <= 1500, `palabras: ${raw.meta.wordCount}`);
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
