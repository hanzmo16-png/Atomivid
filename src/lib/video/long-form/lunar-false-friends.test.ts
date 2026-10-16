import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { DocumentAssetRegistry } from "./asset-identity";
import { assessRelevance, selectStockForShot } from "./stock-selection";
import { normalizeDeclaredVisuals, type BeatVisual } from "./visual-intents";

/**
 * T-23 — falsos amigos lunares frente a terrestres en el selector de stock Long Form.
 *
 * Solo texto del proveedor (descripción/alt), sin descargas ni imágenes: esta capa decide con METADATOS. Que
 * un texto pase NO valida la imagen: los casos "píxeles" quedan documentados aparte y nunca se afirman aquí.
 * Sin red.
 */
globalThis.fetch = (async () => {
  throw new Error("T-23: red prohibida");
}) as typeof fetch;

const scene = (v: Record<string, unknown>): BeatVisual => normalizeDeclaredVisuals([{ motion: false, era: "2020s", beatClass: "PLACE", ...v }], { identity: true })[0];

const CRATER = scene({ description: "close-up of a lunar crater on the Moon's surface", quote: "the crater", subject: "lunar crater", place: "Moon" });
const BASE = scene({ description: "artist concept of a lunar base on the Moon", quote: "the base", subject: "lunar base", place: "Moon" });
const SURFACE = scene({ description: "grey lunar surface under a black sky", quote: "the surface", subject: "lunar surface", place: "Moon" });

// Falsos amigos que el TEXTO del candidato ya delata (deben ser "irrelevant").
const FALSE_FRIENDS: [string, BeatVisual, string][] = [
  ["cráter: lago volcánico", CRATER, "volcanic crater lake in Oregon on a sunny day"],
  ["cráter: volcán activo", CRATER, "crater of an active volcano at sunset"],
  ["cráter: cajas (raíz crat-)", CRATER, "wooden crates stacked in a warehouse"],
  ["cráter: Año Nuevo lunar", CRATER, "lunar new year lanterns at a street festival"],
  ["base: oficina", BASE, "modern office interior with desks and a meeting room"],
  ["base: base militar", BASE, "military base entrance gate with soldiers"],
  ["base: laboratorio con maqueta", BASE, "scientists in a laboratory looking at a moon model"],
  ["base: estación antártica", BASE, "research base in Antarctica covered in snow"],
  ["superficie: desierto nocturno con luna", SURFACE, "full moon rising over a desert surface at night"],
  ["superficie: cantera bajo la luna", SURFACE, "rocky surface of a quarry at night under the moon"],
  ["superficie: paisaje nocturno", SURFACE, "night landscape with mountains and a moon in the sky, rocky ground surface"],
  ["superficie: cielo nocturno", SURFACE, "rocky surface under a night sky with the moon"],
];

// Casos válidos que el selector DEBE conservar (por texto).
const VALID: [string, BeatVisual, string][] = [
  ["cráter: cráteres en la luna", CRATER, "close-up of craters on the moon surface"],
  ["cráter: cráter lunar", CRATER, "lunar crater photographed by an orbiter"],
  ["base: concepto de base lunar", BASE, "artist concept of a lunar base on the moon"],
  ["superficie: astronauta", SURFACE, "astronaut walking on the lunar surface"],
  ["superficie: Apolo", SURFACE, "Apollo landing site on the lunar surface"],
  ["superficie: salida de la Tierra (Earthrise)", SURFACE, "Earth rising over the lunar horizon above the grey surface"],
  ["superficie: Tierra en el cielo lunar", SURFACE, "Earth in the black sky above the lunar surface"],
];

for (const [name, visual, text] of FALSE_FRIENDS) {
  test(`T-23 falso amigo rechazado por metadatos — ${name}`, () => {
    const a = assessRelevance(visual, text);
    assert.equal(a.relevance, "irrelevant", `${text} → ${JSON.stringify(a)}`);
  });
}

for (const [name, visual, text] of VALID) {
  test(`T-23 caso válido conservado — ${name}`, () => {
    const a = assessRelevance(visual, text);
    assert.equal(a.relevance, "keyword_match", `${text} → ${JSON.stringify(a)}`);
  });
}

test("T-23 selector completo: con el falso amigo primero (similitud mayor) elige el candidato lunar, nunca el desierto", async () => {
  const cands: FootageCandidate[] = [
    { url: "https://cdn.example/desert.jpg", sourceId: "desert", description: "full moon rising over a desert surface at night", mediaType: "image", mimeType: "image/jpeg", extension: "jpg" },
    { url: "https://cdn.example/apollo.jpg", sourceId: "apollo", description: "Apollo landing site on the lunar surface", mediaType: "image", mimeType: "image/jpeg", extension: "jpg" },
  ];
  const provider: FootageProvider = {
    name: "t23-fake",
    async fetchFootage() {
      throw new Error("solo búsqueda de candidatos");
    },
    async searchImageCandidates() {
      return cands;
    },
    async searchVideoCandidates() {
      return [];
    },
    async downloadFootage(url) {
      return Buffer.from(`bytes:${url}`);
    },
  };
  const identify = async (b: Buffer) => ({ sha256: createHash("sha256").update(b).digest("hex"), dhashUnavailable: "test" as const });
  const out = await selectStockForShot({ shotId: "t23", visual: SURFACE, preferVideo: false, minDurationSec: 4 }, { footageProvider: provider, registry: new DocumentAssetRegistry(), identify });
  assert.equal(out.status, "selected", JSON.stringify(out));
  assert.equal((out as { candidate?: FootageCandidate }).candidate?.sourceId, "apollo", JSON.stringify(out));
});
