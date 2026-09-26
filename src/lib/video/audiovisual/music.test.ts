import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MUSIC_MANIFEST, type MusicTrackEntry } from "@/lib/providers/music/manifest";
import { MUSIC_DIRECTION_IDS } from "./catalog";
import { MUSIC_RULES, TRACK_CHARACTER, compatibleTrackCount, selectDirectedTracks } from "./music";

test("el catálogo registrado tiene 22 pistas y todas tienen carácter clasificado (incluidas Tension Dark y Tension Pulse)", () => {
  assert.equal(MUSIC_MANIFEST.length, 22);
  for (const track of MUSIC_MANIFEST) assert.ok(TRACK_CHARACTER[track.id], `falta clasificar ${track.id}`);
  const titles = MUSIC_MANIFEST.map((t) => t.title);
  assert.ok(titles.includes("Tension Dark") && titles.includes("Tension Pulse"));
});

test("tensión: solo pistas oscuras/de suspenso; nunca motivacional, corporativa ni alegre", () => {
  const r = selectDirectedTracks({ manifest: MUSIC_MANIFEST, direction: "tension", seed: "req-1" });
  assert.equal(r.status, "matched");
  if (r.status !== "matched") return;
  assert.deepEqual(new Set(r.candidates.map((t) => t.id)), new Set(["elevenlabs-tension-1", "elevenlabs-tension-2"]));
  for (const t of r.candidates) assert.ok(!t.tones.includes("motivational") && !t.tones.includes("corporate"));
});

test("ninguna dirección elige una pista con un carácter prohibido; todas tienen al menos una compatible", () => {
  for (const direction of MUSIC_DIRECTION_IDS) {
    const r = selectDirectedTracks({ manifest: MUSIC_MANIFEST, direction, seed: "x" });
    assert.equal(r.status, "matched", direction);
    if (r.status !== "matched") continue;
    for (const t of r.candidates) {
      const bad = TRACK_CHARACTER[t.id].character.filter((c) => MUSIC_RULES[direction].forbidden.includes(c));
      assert.deepEqual(bad, [], `${direction} eligió ${t.id}`);
    }
    assert.ok(compatibleTrackCount(MUSIC_MANIFEST, direction) > 0);
  }
});

test("sin pista compatible: no_compatible, sin fallback a otra cualquiera", () => {
  const onlyUpbeat = MUSIC_MANIFEST.filter((t) => t.id.startsWith("elevenlabs-motivational"));
  const r = selectDirectedTracks({ manifest: onlyUpbeat, direction: "tension", seed: "s" });
  assert.equal(r.status, "no_compatible");
  const unknown: MusicTrackEntry[] = [{ ...MUSIC_MANIFEST[0], id: "nueva-sin-clasificar", tones: ["tension"] }];
  assert.equal(selectDirectedTracks({ manifest: unknown, direction: "tension", seed: "s" }).status, "no_compatible", "una pista sin clasificar nunca se usa en modo dirigido");
});

test("determinística por semilla; las compatibles de mayor prioridad van primero", () => {
  const a = selectDirectedTracks({ manifest: MUSIC_MANIFEST, direction: "playful", seed: "req-9" });
  const b = selectDirectedTracks({ manifest: MUSIC_MANIFEST, direction: "playful", seed: "req-9" });
  assert.deepEqual(a, b);
  if (a.status !== "matched") return assert.fail();
  assert.equal(a.candidates[0].id, "elevenlabs-energetic-2", "«playful» es el carácter prioritario");
});

test("el proveedor curado en modo dirigido prueba solo compatibles y nunca cae a la selección por palabras", () => {
  const source = readFileSync(path.join(__dirname, "..", "..", "providers", "music", "real.ts"), "utf8");
  const start = source.indexOf("async function getDirectedTrack(");
  const body = source.slice(start);
  assert.ok(source.indexOf("if (direction) return getDirectedTrack(") < source.indexOf("inferTone({"), "el modo dirigido corta antes de inferir tono");
  assert.ok(body.includes("selection.candidates"));
  assert.ok(!body.includes("inferTone") && !body.includes("selectMusicTrack(") && !body.includes("beatoven"));
  assert.ok(body.includes("throw new MusicNoCompatibleTrackError("));
});
