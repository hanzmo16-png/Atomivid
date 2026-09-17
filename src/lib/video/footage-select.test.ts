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
