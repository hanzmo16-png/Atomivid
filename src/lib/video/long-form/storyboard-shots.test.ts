import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildShotsFromStoryboard,
  mapStoryboardAssetType,
  MIN_HOLD_SEC,
  MAX_HOLD_SEC,
  type StoryboardShotInput,
} from "./storyboard-shots";

const SAMPLE_SHOTS: StoryboardShotInput[] = [
  { shotId: "b1-s1", durationApprox: 14, assetType: "text", visualIntent: "intro", hybridClassification: "TEXT" },
  {
    shotId: "b1-s2",
    durationApprox: 14,
    assetType: "stock_video",
    visualIntent: "excavation",
    hybridClassification: "STOCK_REAL",
    licensing: { status: "CLEARED" },
  },
  {
    shotId: "b1-s4",
    durationApprox: 18,
    assetType: "ken_burns_image",
    visualIntent: "landscape",
    hybridClassification: "AI_RECREATION",
  },
];

test("mapStoryboardAssetType traduce todos los valores documentados en meta.assetTypeMapping", () => {
  assert.equal(mapStoryboardAssetType("stock_video"), "stock_video");
  assert.equal(mapStoryboardAssetType("stock_image"), "stock_image");
  assert.equal(mapStoryboardAssetType("documentary_image"), "stock_image");
  assert.equal(mapStoryboardAssetType("map"), "map");
  assert.equal(mapStoryboardAssetType("diagram"), "diagram");
  assert.equal(mapStoryboardAssetType("timeline"), "diagram");
  assert.equal(mapStoryboardAssetType("text"), "text");
  assert.equal(mapStoryboardAssetType("ken_burns_image"), "ken_burns_image");
  assert.equal(mapStoryboardAssetType("generated_image"), "generated_placeholder");
});

test("mapStoryboardAssetType lanza ante un assetType desconocido, nunca cae en silencio a un tipo por defecto", () => {
  assert.throws(() => mapStoryboardAssetType("nonexistent_type"));
});

test("buildShotsFromStoryboard preserva el orden, escala proporcionalmente y cuadra exacto con el span real", () => {
  const shots = buildShotsFromStoryboard({
    beatId: "beat-1",
    beatType: "hook",
    startSec: 0,
    endSec: 54, // planeado: 14+14+18=46s; real: 54s -> factor de escala ~1.174 (mantiene todos los holds dentro de rango)
    storyboardShots: SAMPLE_SHOTS,
  });

  assert.equal(shots.length, 3);
  assert.equal(shots[0].id, "b1-s1");
  assert.equal(shots[1].id, "b1-s2");
  assert.equal(shots[2].id, "b1-s4");
  assert.equal(shots[0].startSec, 0);
  assert.equal(shots[shots.length - 1].endSec, 54);
  // Continuidad: cada shot empieza exactamente donde termina el anterior.
  for (let i = 1; i < shots.length; i++) {
    assert.equal(shots[i].startSec, shots[i - 1].endSec);
  }
  // Proporciones preservadas: b1-s4 (18/46) debe seguir siendo el más largo.
  assert.ok(shots[2].durationSec > shots[0].durationSec);
  assert.ok(shots[2].durationSec > shots[1].durationSec);
});

test("buildShotsFromStoryboard mapea assetType, hybridClassification->source, y transporta visualIntent/caption/licencia reales", () => {
  const shots = buildShotsFromStoryboard({
    beatId: "beat-1",
    beatType: "hook",
    startSec: 0,
    endSec: 46,
    storyboardShots: SAMPLE_SHOTS,
  });

  const textShot = shots[0];
  assert.equal(textShot.type, "text");
  assert.equal(textShot.source, "local");
  assert.equal(textShot.visualIntent, "intro");

  const stockShot = shots[1];
  assert.equal(stockShot.type, "stock_video");
  assert.equal(stockShot.source, "stock");
  assert.match(stockShot.attribution, /CLEARED/);

  const aiShot = shots[2];
  assert.equal(aiShot.type, "ken_burns_image");
  assert.equal(aiShot.source, "generated");
  assert.equal(aiShot.motion, "ken_burns");
});

test("buildShotsFromStoryboard lanza si el beat no tiene ningún shot de storyboard — nunca inventa uno", () => {
  assert.throws(
    () =>
      buildShotsFromStoryboard({
        beatId: "beat-x",
        beatType: "hook",
        startSec: 0,
        endSec: 30,
        storyboardShots: [],
      }),
    /no hay shots de storyboard/,
  );
});

test("buildShotsFromStoryboard lanza si tras escalar algún shot queda fuera de rango razonable", () => {
  // Un solo shot planeado de 5s escalado a un span real de 200s da un hold de 200s — muy fuera de MAX_HOLD_SEC.
  assert.throws(
    () =>
      buildShotsFromStoryboard({
        beatId: "beat-1",
        beatType: "hook",
        startSec: 0,
        endSec: 200,
        storyboardShots: [{ shotId: "b1-s1", durationApprox: 5, assetType: "text", visualIntent: "x" }],
      }),
    new RegExp(`fuera de ${MIN_HOLD_SEC}-${MAX_HOLD_SEC}s`),
  );
});

test("buildShotsFromStoryboard usa el rango de hold documentado (constantes exportadas, no mágicas)", () => {
  assert.equal(MIN_HOLD_SEC, 2.5);
  assert.equal(MAX_HOLD_SEC, 22);
});
