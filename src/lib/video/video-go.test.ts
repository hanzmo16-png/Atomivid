/**
 * T-VIDEO-GO-20261122: Reel de duración exacta (30 s = 900 fotogramas a 30 fps) y datos para YouTube en Long Form.
 * Pure checks only: no provider, no network, no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reelFinalDurationSeconds, reelSpeedToFit } from "@/lib/video/duration-check";
import { VIDEO_TAIL_SECONDS } from "@/lib/video/script-pacing";
import { parseYoutubeMetadata, youtubeMetadata, youtubeMetadataPath } from "@/lib/delivery/youtube-package";

const FPS = 30;
const frames = (s: number) => Math.max(1, Math.round(s * FPS));

test("Reel 30 s: narración que cabe → exactamente 900 fotogramas (se sostiene el último plano)", () => {
  for (const voice of [27.0, 28.4, 29.0, 29.5]) {
    assert.equal(frames(reelFinalDurationSeconds(30, voice, VIDEO_TAIL_SECONDS)), 900, `voz ${voice}`);
    assert.equal(reelSpeedToFit(30, voice, VIDEO_TAIL_SECONDS), null, "no hace falta corregir el ritmo");
  }
  assert.equal(frames(reelFinalDurationSeconds(15, 13.9, VIDEO_TAIL_SECONDS)), 450);
  assert.equal(frames(reelFinalDurationSeconds(60, 57.2, VIDEO_TAIL_SECONDS)), 1800);
});

test("Reel 30 s: narración que no cabe pide UNA corrección hacia objetivo − cola; nunca se corta la voz", () => {
  // Caso real del E2E de hoy en producción: 29.64 s de voz + 0.5 → 30.14 s = 904 fotogramas.
  const speed = reelSpeedToFit(30, 29.64, VIDEO_TAIL_SECONDS);
  assert.ok(speed !== null && Math.abs(speed - 29.64 / 29.5) < 1e-9);
  const speed2 = reelSpeedToFit(30, 32.5, VIDEO_TAIL_SECONDS)!;
  assert.ok(speed2 > 1 && speed2 < 1.15);
  // Si la voz corregida sigue sin caber, la duración es la real (más larga): jamás se recorta la narración.
  assert.equal(reelFinalDurationSeconds(30, 29.8, VIDEO_TAIL_SECONDS), 29.8 + VIDEO_TAIL_SECONDS);
});

test("Reel sin objetivo o con valores inválidos: comportamiento previo (voz + cola)", () => {
  assert.equal(reelFinalDurationSeconds(undefined, 20, VIDEO_TAIL_SECONDS), 20.5);
  assert.equal(reelFinalDurationSeconds(0, 20, VIDEO_TAIL_SECONDS), 20.5);
  assert.equal(reelSpeedToFit(0.4, 10, VIDEO_TAIL_SECONDS), null);
  assert.equal(reelSpeedToFit(30, 0, VIDEO_TAIL_SECONDS), null);
});

test("generate-video usa la duración exacta y la corrección única (sin una tercera llamada de voz)", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/video/generate-video.ts"), "utf8");
  assert.match(src, /const finalDurationSeconds = reelFinalDurationSeconds\(targetDurationSeconds, voice\.durationSeconds, VIDEO_TAIL_SECONDS\);/);
  assert.equal((src.match(/await synthesizeCounted\(/g) ?? []).length, 2, "como antes: síntesis inicial + una corrección");
});

test("YouTube: título, descripción con capítulos desde los tiempos reales, sin afirmar fuentes", () => {
  const m = youtubeMetadata({
    topic: "El Canal de Panamá: cómo se unieron dos océanos",
    language: "es",
    beats: [
      { text: "En 1914 un barco cruzó un continente. Nadie lo creía posible.", startSeconds: 0.4, endSeconds: 62 },
      { text: "Los franceses fracasaron primero ante la malaria y el barro.", startSeconds: 62, endSeconds: 180 },
      { text: "Estados Unidos cambió el plan: esclusas en lugar de un canal a nivel.", startSeconds: 180, endSeconds: 300 },
      { text: "Hoy pasan por allí catorce mil barcos al año.", startSeconds: 300, endSeconds: 420 },
    ],
  });
  assert.equal(m.title, "El Canal de Panamá");
  assert.match(m.description, /^En 1914 un barco cruzó un continente\./);
  assert.match(m.description, /Capítulos:\n0:00 En 1914 un barco cruzó un continente\n1:02 /);
  assert.equal(m.chapters[0].start, 0, "YouTube exige el primer capítulo en 0:00");
  assert.equal(m.chapters.length, 4);
  assert.doesNotMatch(m.description, /licencia|SOURCES\.md|Material visual/i);
  assert.ok(m.tags.includes("canal") && m.tags.includes("panamá"));
  assert.equal(youtubeMetadataPath("abc"), "abc/output/youtube.json");
  assert.deepEqual(parseYoutubeMetadata(JSON.parse(JSON.stringify(m))), m);
});

test("YouTube: con menos de 3 bloques ≥10 s no se inventan capítulos; lecturas inválidas se descartan", () => {
  const m = youtubeMetadata({ topic: "Pulpos", language: "en", beats: [{ text: "Octopuses have three hearts.", startSeconds: 0, endSeconds: 40 }] });
  assert.deepEqual(m.chapters, []);
  assert.doesNotMatch(m.description, /Chapters/);
  for (const bad of [null, 1, {}, { version: 2, title: "x", description: "" }, { version: 1, title: "  ", description: "d" }]) assert.equal(parseYoutubeMetadata(bad), null);
});
