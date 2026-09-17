import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCandidate, rankCandidates, MIN_ACCEPTABLE_SCORE } from "./footage-score";
import type { FootageCandidate } from "@/lib/providers/types";

function candidate(overrides: Partial<FootageCandidate> = {}): FootageCandidate {
  return {
    url: "https://example.test/clip.mp4",
    sourceId: "src-1",
    mediaType: "video",
    mimeType: "video/mp4",
    extension: "mp4",
    width: 1080,
    height: 1920,
    durationSeconds: 4,
    photographer: "Jane Doe",
    ...overrides,
  };
}

test("un video en alta resolución del concepto principal puntúa por encima del umbral mínimo", () => {
  const result = scoreCandidate(candidate(), {
    conceptTier: 0,
    photographerUseCount: new Map(),
    minimumDurationSeconds: 3,
  });
  assert.ok(result.score >= MIN_ACCEPTABLE_SCORE, `score=${result.score}`);
});

test("un concepto alternativo (tier > 0) puntúa menos que el mismo candidato como tier 0", () => {
  const tier0 = scoreCandidate(candidate(), {
    conceptTier: 0,
    photographerUseCount: new Map(),
    minimumDurationSeconds: 3,
  });
  const tier2 = scoreCandidate(candidate(), {
    conceptTier: 2,
    photographerUseCount: new Map(),
    minimumDurationSeconds: 3,
  });
  assert.ok(tier2.score < tier0.score);
});

test("video puntúa más que imagen en igualdad de condiciones", () => {
  const video = scoreCandidate(candidate({ mediaType: "video" }), {
    conceptTier: 0,
    photographerUseCount: new Map(),
    minimumDurationSeconds: 3,
  });
  const image = scoreCandidate(candidate({ mediaType: "image", durationSeconds: undefined }), {
    conceptTier: 0,
    photographerUseCount: new Map(),
    minimumDurationSeconds: 3,
  });
  assert.ok(video.score > image.score);
});

test("baja resolución puntúa menos que alta resolución", () => {
  const hd = scoreCandidate(candidate({ width: 1080 }), {
    conceptTier: 0,
    photographerUseCount: new Map(),
    minimumDurationSeconds: 3,
  });
  const low = scoreCandidate(candidate({ width: 480 }), {
    conceptTier: 0,
    photographerUseCount: new Map(),
    minimumDurationSeconds: 3,
  });
  assert.ok(hd.score > low.score);
});

test("reusar el mismo fotógrafo dentro del video penaliza el score (diversidad)", () => {
  const fresh = scoreCandidate(candidate(), {
    conceptTier: 0,
    photographerUseCount: new Map(),
    minimumDurationSeconds: 3,
  });
  const reused = scoreCandidate(candidate(), {
    conceptTier: 0,
    photographerUseCount: new Map([["jane doe", 2]]),
    minimumDurationSeconds: 3,
  });
  assert.ok(reused.score < fresh.score);
});

test("rankCandidates ordena de mayor a menor score", () => {
  const low = { candidate: candidate({ sourceId: "a" }), score: 2, reasons: [] };
  const high = { candidate: candidate({ sourceId: "b" }), score: 9, reasons: [] };
  const mid = { candidate: candidate({ sourceId: "c" }), score: 5, reasons: [] };
  const ranked = rankCandidates([low, high, mid]);
  assert.deepEqual(
    ranked.map((r) => r.candidate.sourceId),
    ["b", "c", "a"],
  );
});
