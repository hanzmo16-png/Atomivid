import assert from "node:assert/strict";
import test from "node:test";

import { selectMusicTrack, seededIndex } from "./select";
import type { MusicTrackEntry } from "./manifest";

function track(id: string, tones: MusicTrackEntry["tones"]): MusicTrackEntry {
  return {
    id,
    title: id,
    author: "Test",
    sourceUrl: "https://example.com",
    license: "Test License",
    provider: "test",
    dateObtainedISO: "2026-01-01",
    instrumental: true,
    tones,
    styleTags: [],
    storageUrl: `https://example.com/${id}.mp3`,
  };
}

test("manifest vacío devuelve 'empty'", () => {
  const result = selectMusicTrack({ manifest: [], tones: ["motivational"], seed: "a" });
  assert.equal(result.status, "empty");
});

test("prioriza la pista con más tonos coincidentes", () => {
  const manifest = [
    track("no-match", ["luxury"]),
    track("one-match", ["motivational"]),
    track("two-match", ["motivational", "energetic"]),
  ];
  const result = selectMusicTrack({
    manifest,
    tones: ["motivational", "energetic"],
    seed: "req-1",
  });
  assert.equal(result.status, "matched");
  assert.equal(result.status === "matched" && result.track.id, "two-match");
});

test("sin ninguna coincidencia de tono, cae a 'fallback' con cualquier pista", () => {
  const manifest = [track("a", ["luxury"]), track("b", ["technology"])];
  const result = selectMusicTrack({ manifest, tones: ["tension"], seed: "req-2" });
  assert.equal(result.status, "fallback");
});

test("misma seed + mismo manifest ⇒ misma pista (repetible)", () => {
  const manifest = [track("a", ["motivational"]), track("b", ["motivational"]), track("c", ["motivational"])];
  const first = selectMusicTrack({ manifest, tones: ["motivational"], seed: "same-seed" });
  const second = selectMusicTrack({ manifest, tones: ["motivational"], seed: "same-seed" });
  assert.deepEqual(first, second);
});

test("seeds distintas tienden a elegir pistas distintas dentro de un pool empatado", () => {
  const manifest = [
    track("a", ["motivational"]),
    track("b", ["motivational"]),
    track("c", ["motivational"]),
    track("d", ["motivational"]),
  ];
  const ids = new Set(
    ["req-1", "req-2", "req-3", "req-4", "req-5", "req-6"].map((seed) => {
      const result = selectMusicTrack({ manifest, tones: ["motivational"], seed });
      return result.status === "matched" ? result.track.id : null;
    }),
  );
  assert.ok(ids.size > 1, "se esperaba variedad entre distintas seeds");
});

test("seededIndex siempre cae dentro del rango [0, length)", () => {
  for (const seed of ["", "x", "solicitud-123", "🎵"]) {
    const index = seededIndex(seed, 5);
    assert.ok(index >= 0 && index < 5);
  }
});

test("seededIndex con length 0 no revienta", () => {
  assert.equal(seededIndex("cualquier-cosa", 0), 0);
});
