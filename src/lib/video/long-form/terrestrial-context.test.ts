import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRelevance } from "./stock-selection";
import { normalizeDeclaredVisuals, type BeatVisual } from "./visual-intents";

/**
 * T-23 CORRECCIÓN-1 — la puerta de «contexto celeste» solo puede abrirse por la UBICACIÓN de la escena.
 *
 * Un documental terrestre que nombra «planet Earth», una galaxia o un astronauta en el sujeto o la descripción
 * NO está fuera de la Tierra: sus candidatos legítimos (bosques, playas, lagos, festivales…) deben seguir
 * pasando. Solo texto del proveedor; sin red, sin imágenes (QA_VISUAL_PENDIENTE sigue vigente).
 */
globalThis.fetch = (async () => {
  throw new Error("T-23 C1: red prohibida");
}) as typeof fetch;

const scene = (v: Record<string, unknown>): BeatVisual => normalizeDeclaredVisuals([{ motion: false, era: "2020s", beatClass: "PLACE", ...v }], { identity: true })[0];

// Contraejemplos de la auditoría (Codex, 2026-10-16): escenas terrestres con léxico «celeste» en sujeto/descripción.
const EARTH_SCENES: [string, BeatVisual, string][] = [
  // The full subject ("planet Earth") is still required — that rule stays; what must NOT happen is a conflict on "forest"/"beach".
  ["planeta Tierra: bosque y playa", scene({ description: "forests and beaches of planet Earth seen from above", quote: "our planet", subject: "planet Earth", place: "Earth" }), "aerial forest and beach on planet Earth"],
  ["planeta Tierra: lago", scene({ description: "the blue planet with its lakes", quote: "the planet", subject: "planet Earth", place: "Earth" }), "planet Earth lake and forest from above"],
  ["astronauta retirado en un festival", scene({ description: "a retired astronaut giving a talk at a science festival", quote: "he spoke", subject: "retired astronaut", place: "Houston" }), "retired astronaut speaking at a science festival in Houston"],
  ["galaxia vista desde un lago", scene({ description: "an amateur astronomer watches the galaxy from a lake shore", quote: "the galaxy", subject: "amateur astronomer", place: "Chile" }), "amateur astronomer with a telescope by a lake at night, the galaxy above"],
  ["volcán con nombre de planeta", scene({ description: "a volcano on the island", quote: "the volcano", subject: "volcano", place: "Hawaii" }), "volcano crater in Hawaii with tourists on the rim, planet Earth at its rawest"],
];

for (const [name, visual, text] of EARTH_SCENES) {
  test(`T-23 C1 escena terrestre conservada — ${name}`, () => {
    const a = assessRelevance(visual, text);
    assert.equal(a.relevance, "keyword_match", `${text} → ${JSON.stringify(a)}`);
    assert.deepEqual(a.conflicts, [], `sin conflictos de contexto terrestre: ${JSON.stringify(a)}`);
  });
}

// La puerta sigue cerrando cuando la UBICACIÓN sí está fuera de la Tierra.
const OFF_EARTH: [string, BeatVisual, string][] = [
  ["Marte: desierto con turistas", scene({ description: "red martian desert", quote: "mars", subject: "martian desert", place: "Mars" }), "red desert in Arizona with tourists, looks like mars"],
  ["órbita: estación espacial", scene({ description: "the station over the clouds", quote: "the station", subject: "space station", place: "low Earth orbit" }), "space station exhibit at a science festival"],
  ["Luna: cráter", scene({ description: "close-up of a lunar crater", quote: "the crater", subject: "lunar crater", place: "Moon" }), "volcanic crater lake in Oregon, moon above"],
];

for (const [name, visual, text] of OFF_EARTH) {
  test(`T-23 C1 ubicación extraterrestre: contexto terrestre rechazado — ${name}`, () => {
    const a = assessRelevance(visual, text);
    assert.equal(a.relevance, "irrelevant", `${text} → ${JSON.stringify(a)}`);
    assert.ok(a.conflicts.some((c) => c.startsWith("contexto terrestre")), JSON.stringify(a));
  });
}

test("T-23 C1 sin ubicación declarada no se asume contexto celeste (ni se rechaza por él)", () => {
  const noPlace = scene({ description: "an astronaut suit in a museum", quote: "the suit", subject: "astronaut suit" });
  const a = assessRelevance(noPlace, "astronaut suit displayed at a museum festival");
  assert.equal(a.relevance, "keyword_match", JSON.stringify(a));
  assert.deepEqual(a.conflicts, []);
});
