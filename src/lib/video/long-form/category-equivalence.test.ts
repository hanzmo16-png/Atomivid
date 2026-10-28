import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRelevance } from "./stock-selection";
import { normalizeDeclaredVisuals, type BeatVisual } from "./visual-intents";

/**
 * Incidente 2026-10-28 («Un día en la sabana africana», 34 escenas sin material): equivalencias de CATEGORÍA
 * de un solo sentido. Un sujeto que nombra la categoría («herbivores», «savanna») acepta un candidato que nombra
 * un miembro; nunca al revés, ni entre miembros. Las protecciones de falsos amigos se mantienen. Sin red.
 */
globalThis.fetch = (async () => {
  throw new Error("red prohibida");
}) as typeof fetch;

const scene = (v: Record<string, unknown>): BeatVisual => normalizeDeclaredVisuals([{ motion: false, era: "2020s", beatClass: "PLACE", ...v }], { identity: true })[0];

const HERBIVORES = scene({ description: "herbivores grazing at dawn", quote: "los herbívoros", subject: "herbivores" });
const SAVANNA = scene({ description: "golden savanna at sunrise", quote: "la sabana", subject: "savanna" });
const SAVANNA_HERBIVORES = scene({ description: "herbivores crossing the savanna", quote: "la manada", subject: "savanna herbivores" });

const ACCEPTED: [string, BeatVisual, string][] = [
  ["real 2026-10-28: herbivores vs búfalo africano", HERBIVORES, "african buffalo grazing in natural habitat"],
  ["herbivores vs cebras", HERBIVORES, "a herd of zebras at the waterhole"],
  ["herbivores vs ñus", HERBIVORES, "wildebeest migration across the river"],
  ["savanna vs savannah", SAVANNA, "acacia tree on the savannah at sunset"],
  ["savanna vs grassland", SAVANNA, "african grassland under a stormy sky"],
  ["savanna vs open plains", SAVANNA, "wind moving over the open plains"],
  ["savanna herbivores vs zebras on the savannah", SAVANNA_HERBIVORES, "zebras on the savannah"],
];

const REJECTED: [string, BeatVisual, string][] = [
  ["miembro vs otro miembro: zebra vs giraffe", scene({ description: "a zebra drinking", quote: "la cebra", subject: "zebra" }), "giraffe in the savanna"],
  ["miembro no acepta la categoría: giraffe vs herbivores", scene({ description: "a giraffe eating leaves", quote: "la jirafa", subject: "giraffe" }), "herbivores grazing in the savanna"],
  ["herbivores vs paso de cebra", HERBIVORES, "pedestrians on a zebra crossing in the city"],
  ["herbivores vs alitas buffalo", HERBIVORES, "plate of buffalo wings with dip"],
  ["savanna vs fondo liso", SAVANNA, "product on a plain background"],
  ["real 2026-10-28: savanna sun vs humo sobre la sabana (no hay sol)", scene({ description: "the sun rising over the savanna", quote: "el sol", subject: "savanna sun" }), "aerial view of smoke over african savanna"],
  ["lunar crater vs volcanic crater (sin cambios)", scene({ description: "close-up of a lunar crater", quote: "the crater", subject: "lunar crater", place: "Moon" }), "volcanic crater lake in Oregon, mountains"],
];

for (const [name, visual, text] of ACCEPTED) {
  test(`categoría aceptada — ${name}`, () => {
    const a = assessRelevance(visual, text);
    assert.equal(a.relevance, "keyword_match", `${text} → ${JSON.stringify(a)}`);
  });
}

for (const [name, visual, text] of REJECTED) {
  test(`categoría rechazada — ${name}`, () => {
    const a = assessRelevance(visual, text);
    assert.equal(a.relevance, "irrelevant", `${text} → ${JSON.stringify(a)}`);
  });
}
