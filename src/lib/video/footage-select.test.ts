import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFootageSelectionState,
  selectFootageForScene,
  FootageSelectionError,
  buildFallbackQuery,
} from "./footage-select";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";

function makeCandidate(sourceId: string, overrides: Partial<FootageCandidate> = {}): FootageCandidate {
  return {
    url: `https://example.test/${sourceId}.mp4`,
    sourceId,
    mediaType: "video",
    mimeType: "video/mp4",
    extension: "mp4",
    width: 1080,
    height: 1920,
    durationSeconds: 4,
    photographer: sourceId,
    ...overrides,
  };
}

test("elige el mejor candidato del concepto principal cuando hay varios disponibles", async () => {
  const provider: FootageProvider = {
    name: "fake",
    async fetchFootage() {
      throw new Error("no debería llamarse — el fake tiene searchVideoCandidates");
    },
    async downloadFootage() {
      return Buffer.from("");
    },
    async searchVideoCandidates(query) {
      if (query !== "runner falling behind") return [];
      return [
        makeCandidate("low-res", { width: 480 }),
        makeCandidate("high-res", { width: 1080 }),
      ];
    },
  };

  const state = createFootageSelectionState();
  const outcome = await selectFootageForScene({
    provider,
    concepts: ["runner falling behind", "person quitting"],
    minimumDurationSeconds: 2,
    state,
  });

  assert.equal(outcome.sourceId, "high-res");
  assert.equal(outcome.usedFallbackQuery, false);
  assert.equal(outcome.conceptTier, 0);
});

test("nunca reutiliza un sourceId ya usado en el mismo video (estado compartido)", async () => {
  const provider: FootageProvider = {
    name: "fake",
    async fetchFootage() {
      throw new Error("no debería llamarse");
    },
    async downloadFootage() {
      return Buffer.from("");
    },
    async searchVideoCandidates() {
      // Siempre devuelve el MISMO único candidato, sin importar la consulta.
      return [makeCandidate("only-clip")];
    },
  };

  const state = createFootageSelectionState();
  const first = await selectFootageForScene({
    provider,
    concepts: ["concept a"],
    minimumDurationSeconds: 2,
    state,
  });
  assert.equal(first.sourceId, "only-clip");

  // La segunda escena pide el mismo candidato — como ya está en
  // usedSourceIds, no hay nada nuevo que ofrecer y debe caer al error
  // (no hay searchImageCandidates en este fake).
  await assert.rejects(
    () =>
      selectFootageForScene({
        provider,
        concepts: ["concept b"],
        minimumDurationSeconds: 2,
        state,
      }),
    FootageSelectionError,
  );
});

test("reformula la consulta si el concepto original no trae ningún candidato", async () => {
  const calls: string[] = [];
  const provider: FootageProvider = {
    name: "fake",
    async fetchFootage() {
      throw new Error("no debería llamarse");
    },
    async downloadFootage() {
      return Buffer.from("");
    },
    async searchVideoCandidates(query) {
      calls.push(query);
      if (query === "exhausted athlete stopping mid run") {
        return []; // Pexels no tiene nada para una consulta tan específica.
      }
      // La consulta reformulada ("exhausted athlete") sí trae algo.
      return [makeCandidate("good", { width: 1080 })];
    },
  };

  const state = createFootageSelectionState();
  const outcome = await selectFootageForScene({
    provider,
    concepts: ["exhausted athlete stopping mid run"],
    minimumDurationSeconds: 2,
    state,
  });

  assert.equal(outcome.usedFallbackQuery, true);
  assert.equal(outcome.queryUsed, buildFallbackQuery("exhausted athlete stopping mid run"));
  assert.ok(calls.includes(outcome.queryUsed));
});

test("un candidato con score bajo (mismo fotógrafo repetido muchas veces) igual queda por debajo del umbral", async () => {
  const provider: FootageProvider = {
    name: "fake",
    async fetchFootage() {
      throw new Error("no debería llamarse");
    },
    async downloadFootage() {
      return Buffer.from("");
    },
    async searchVideoCandidates(query, tier) {
      // Cada consulta (principal + reformulada) ofrece un candidato nuevo
      // del MISMO fotógrafo ya sobreusado — ninguno debería superar el
      // umbral una vez que la penalización por diversidad se acumula.
      return [makeCandidate(`${query}-${tier}`, { photographer: "same-photographer" })];
    },
  };

  const state = createFootageSelectionState();
  state.photographerUseCount.set("same-photographer", 10); // penalización acumulada muy alta

  await assert.rejects(
    () =>
      selectFootageForScene({
        provider,
        concepts: ["concept a"],
        minimumDurationSeconds: 2,
        state,
      }),
    FootageSelectionError,
  );
});

test("cae a imagen cuando ningún concepto encuentra video aprovechable", async () => {
  const provider: FootageProvider = {
    name: "fake",
    async fetchFootage() {
      throw new Error("no debería llamarse");
    },
    async downloadFootage() {
      return Buffer.from("");
    },
    async searchVideoCandidates() {
      return [];
    },
    async searchImageCandidates() {
      return [makeCandidate("photo-1", { mediaType: "image" as const })];
    },
  };

  const state = createFootageSelectionState();
  const outcome = await selectFootageForScene({
    provider,
    concepts: ["concept a", "concept b"],
    minimumDurationSeconds: 2,
    state,
  });

  assert.equal(outcome.result.mediaType, "image");
  assert.equal(outcome.usedFallbackQuery, true);
});

test("lanza FootageSelectionError si no hay ningún candidato en absoluto", async () => {
  const provider: FootageProvider = {
    name: "fake",
    async fetchFootage() {
      throw new Error("no debería llamarse");
    },
    async downloadFootage() {
      return Buffer.from("");
    },
    async searchVideoCandidates() {
      return [];
    },
    async searchImageCandidates() {
      return [];
    },
  };

  const state = createFootageSelectionState();
  await assert.rejects(
    () =>
      selectFootageForScene({
        provider,
        concepts: ["nada de nada"],
        minimumDurationSeconds: 2,
        state,
      }),
    FootageSelectionError,
  );
});

test("un proveedor sin searchVideoCandidates/searchImageCandidates cae a fetchFootage (compatibilidad)", async () => {
  const provider: FootageProvider = {
    name: "legacy-fixture",
    async fetchFootage(query) {
      return {
        url: `data:image/svg+xml;utf8,${query}`,
        mediaType: "image",
        mimeType: "image/svg+xml",
        extension: "svg",
        photographer: "fixture",
      };
    },
    async downloadFootage() {
      return Buffer.from("");
    },
  };

  const state = createFootageSelectionState();
  const outcome = await selectFootageForScene({
    provider,
    concepts: ["cualquier cosa"],
    minimumDurationSeconds: 2,
    state,
  });

  assert.equal(outcome.result.mediaType, "image");
  assert.ok(state.usedSourceIds.size === 1);
});

test("buildFallbackQuery toma como máximo las 2 primeras palabras", () => {
  assert.equal(buildFallbackQuery("exhausted athlete stopping mid run"), "exhausted athlete");
  assert.equal(buildFallbackQuery("runner"), "runner");
  assert.equal(buildFallbackQuery("   "), "b-roll");
});

// Production regression: a phone-recording hook previously chose an angry man
// because technical rank was used as evidence of subject relevance.
const phoneOpening = [
  "person frustrated phone recording",
  "confused creator looking at phone screen",
  "blurry dark video playback on phone",
];
function openingProvider(candidates: FootageCandidate[], calls: string[] = []): FootageProvider {
  return {
    name: "fake",
    async fetchFootage() { throw new Error("unverified legacy selection must not run"); },
    async downloadFootage() { return Buffer.from(""); },
    async searchVideoCandidates(query) { calls.push(query); return candidates; },
  };
}
const openingArgs = (provider: FootageProvider, concepts = phoneOpening) => ({
  provider, concepts, minimumDurationSeconds: 3,
  state: createFootageSelectionState(), isOpening: true,
});

test("apertura: el objeto y la actividad ganan a una reacción genérica en 4K", async () => {
  const outcome = await selectFootageForScene(openingArgs(openingProvider([
    makeCandidate("angry", { width: 2160, description: "Angry man in a blue shirt" }),
    makeCandidate("filming", { width: 720, description: "Woman filming with a smartphone" }),
    makeCandidate("studio", { description: "Man recording audio in a studio" }),
  ])));
  assert.equal(outcome.sourceId, "filming");
  assert.deepEqual(outcome.openingRelevance?.matchedTerms, ["phone", "record"]);
  assert.equal(outcome.openingRelevance?.visualInspection, false);
  assert.equal(outcome.providerDescription, "Woman filming with a smartphone");
});

test("apertura: búsqueda exacta y resolución no validan un clip sin descripción", async () => {
  const calls: string[] = [];
  const args = openingArgs(openingProvider([makeCandidate("unverified", { width: 2160 })], calls));
  await assert.rejects(() => selectFootageForScene(args), { name: "OpeningFootageUnavailableError" });
  assert.deepEqual(calls, [...phoneOpening, "phone recording"]);
  assert.equal(args.state.usedSourceIds.size, 0);
  assert.equal(args.state.photographerUseCount.size, 0);
});

test("apertura: reacciones exageradas o contenido excluido no se cuelan por mencionar el objeto", async () => {
  const args = openingArgs(openingProvider([
    makeCandidate("scream", { description: "Man screaming while recording on a phone" }),
    makeCandidate("excluded", { description: "Woman filming with a smartphone in a studio" }),
  ]));
  await assert.rejects(() => selectFootageForScene({ ...args, excludedTerms: ["studio"] }), { name: "OpeningFootageUnavailableError" });
  assert.equal(args.state.usedSourceIds.size, 0);
});

test("apertura: permite reacciones cuando sí son el asunto explícito", async () => {
  const outcome = await selectFootageForScene(openingArgs(openingProvider([
    makeCandidate("acting", { description: "Actor screaming in a theater" }),
  ]), ["actor screaming theater"]));
  assert.equal(outcome.sourceId, "acting");
});

test("apertura: el respaldo conserva la actividad y funciona para otros temas", async () => {
  const calls: string[] = [];
  const provider = openingProvider([], calls);
  provider.searchVideoCandidates = async query => {
    calls.push(query);
    return query === "chopping vegetables" ? [makeCandidate("cook", { description: "Chef chopping fresh vegetables" })] : [];
  };
  const outcome = await selectFootageForScene(openingArgs(provider, ["happy person chopping vegetables"]));
  assert.equal(outcome.sourceId, "cook");
  assert.equal(outcome.queryUsed, "chopping vegetables");
  assert.equal(outcome.usedFallbackQuery, true);
  assert.deepEqual(calls, ["happy person chopping vegetables", "chopping vegetables"]);
});

test("apertura: imagen de respaldo también necesita relación comprobable", async () => {
  const provider = openingProvider([]);
  provider.searchImageCandidates = async () => [
    makeCandidate("generic-photo", { mediaType: "image", description: "Angry man" }),
    makeCandidate("phone-photo", { mediaType: "image", description: "Smartphone recording on a tripod" }),
  ];
  const outcome = await selectFootageForScene(openingArgs(provider));
  assert.equal(outcome.sourceId, "phone-photo");
  assert.equal(outcome.result.mediaType, "image");
  assert.equal(outcome.openingRelevance?.accepted, true);
});

test("apertura: un candidato más descriptivo bajo el umbral no oculta otro válido", async () => {
  const args = openingArgs(openingProvider([
    makeCandidate("overused", { description: "Phone recording screen blurry dark playback", photographer: "overused" }),
    makeCandidate("valid", { description: "Woman filming with a smartphone" }),
  ]));
  args.state.photographerUseCount.set("overused", 20);
  const outcome = await selectFootageForScene(args);
  assert.equal(outcome.sourceId, "valid");
});

test("apertura: proveedor sin candidatos verificables no puede saltar la comprobación", async () => {
  const provider = openingProvider([]);
  delete provider.searchVideoCandidates;
  await assert.rejects(() => selectFootageForScene(openingArgs(provider)), { name: "OpeningFootageUnavailableError" });
});

test("apertura: a igualdad de relevancia prefiere detalle útil tras recortar a vertical", async () => {
  const outcome = await selectFootageForScene(openingArgs(openingProvider([
    makeCandidate("horizontal", { width: 1920, height: 1080, description: "Woman filming with a smartphone" }),
    makeCandidate("vertical", { width: 720, height: 1280, description: "Woman filming with a smartphone" }),
  ])));
  assert.equal(outcome.sourceId, "vertical");
});

test("apertura: exclusiones usan los mismos sinónimos que la aceptación", async () => {
  const args = openingArgs(openingProvider([
    makeCandidate("excluded", { description: "Woman filming with a smartphone" }),
  ]));
  await assert.rejects(() => selectFootageForScene({ ...args, excludedTerms: ["phone"] }),
    { name: "OpeningFootageUnavailableError" });
  assert.equal(args.state.usedSourceIds.size, 0);
});

test("apertura: excluir phone no excluye headphones por coincidencia parcial", async () => {
  const outcome = await selectFootageForScene({
    ...openingArgs(openingProvider([
      makeCandidate("headphones", { description: "Musician recording with headphones" }),
    ]), ["musician recording headphones"]), excludedTerms: ["phone"],
  });
  assert.equal(outcome.sourceId, "headphones");
});
