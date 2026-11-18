import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AudioEditor, type Synthesis } from "./AudioEditor";
import { AudioLibrary } from "./AudioLibrary";
import { applyInput, newProject, type AudioProject, type AudioResult } from "@/lib/audio-studio/model";
import { view } from "@/lib/audio-studio/service";
import { voiceAvailability } from "@/lib/audio-studio/voice";
import { SEED_EPISODE } from "@/lib/audio-studio/seed";

/** Voz de demostración (solo la cuenta dueña): rótulo inequívoco, USD 0.00 y audio marcado como demo. Sin red. */
const A = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-17T12:00:00.000Z";
const LABEL = /Voz de demostración — no es la voz final; USD 0/;
const DEMO = voiceAvailability({ AUDIO_STUDIO_VOICE: "demo", NODE_ENV: "production" }, undefined, { owner: true });
const base = () => applyInput(newProject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000077", ownerId: A, now: NOW, title: SEED_EPISODE.title }), {
  voices: [SEED_EPISODE.voice], targetMinutes: 18, script: SEED_EPISODE.script, music: SEED_EPISODE.music, budgetUsd: SEED_EPISODE.budgetUsd,
}, NOW);
const AUDIO: AudioResult = { path: `audio-studio/v1/${A}/aaaaaaaa-aaaa-4aaa-8aaa-000000000077/audio/r1-1.mp3`, bytes: 1_000_000, sha256: "0".repeat(64), durationSeconds: 600, lufs: -16, truePeak: -1.5,
  revision: 1, renderedAt: NOW, provider: "demo", model: "eleven_v4_turbo", segments: 10, reusedSegments: 0, musicTracks: [] };
const html = (synthesis: Synthesis | null, patch: Partial<AudioProject> = {}, voice = DEMO) =>
  renderToStaticMarkup(<AudioEditor initial={view({ ...base(), ...patch }, {}, voice)} synthesis={synthesis} />);

test("editor con voz de demostración: rótulo visible, costo USD 0.00, confirmación a USD 0.00 y botón de demo", () => {
  const h = html("demo");
  assert.match(h, /data-testid="audio-voice-demo"/);
  assert.match(h, LABEL);
  assert.match(h, /data-testid="audio-estimated-usd">USD 0\.00</);
  assert.match(h, /data-testid="audio-rate">USD 0\.00 \/ 1 000 caracteres/);
  assert.match(h, /Confirmo generar con la voz de demostración por <strong data-testid="audio-authorize-usd">USD 0\.00<\/strong>/);
  assert.doesNotMatch(h, /Autorizo un gasto/);
  assert.match(h, /Generar MP3 de demostración/);
  assert.doesNotMatch(h, /data-testid="audio-voice-disabled"/);
});

test("audio producido con la voz demo: marcado en el editor y en la biblioteca", () => {
  const h = html("demo", { audio: AUDIO });
  assert.match(h, /data-testid="audio-result"/);
  assert.match(h, /· Voz de demostración — no es la voz final; USD 0/);
  const lib = renderToStaticMarkup(<AudioLibrary projects={[view({ ...base(), audio: AUDIO }, {}, DEMO)]} archived={false} />);
  assert.match(lib, LABEL);
  assert.match(lib, /Costo estimado USD 0\.00/);
  // El mismo audio visto por una cuenta sin demo sigue marcado como demo (nunca pasa por voz real).
  const real = renderToStaticMarkup(<AudioLibrary projects={[view({ ...base(), audio: { ...AUDIO, provider: "elevenlabs" } }, {})]} archived={false} />);
  assert.doesNotMatch(real, LABEL);
});

test("cliente (no dueño) con AUDIO_STUDIO_VOICE=demo: igual que hoy («inactiva», sin gasto, costo normal, sin rótulo demo)", () => {
  const blocked = voiceAvailability({ AUDIO_STUDIO_VOICE: "demo", NODE_ENV: "production" }, undefined, { owner: false });
  const h = html("inactiva", {}, blocked);
  assert.match(h, /data-testid="audio-voice-disabled"/);
  assert.doesNotMatch(h, LABEL);
  assert.doesNotMatch(h, /data-testid="audio-generate"/);
  assert.match(h, /data-testid="audio-estimated-usd">USD [1-9]\.\d\d</);
});

test("ruta de voces: «demo» se decide con la cuenta autenticada y antes del catálogo de pago", () => {
  const src = readFileSync("src/app/api/audio-studio/voices/route.ts", "utf8");
  assert.ok(src.indexOf("audioStudioUser()") < src.indexOf("studioVoiceFor(user)"));
  assert.ok(src.indexOf('"demo"') > 0 && src.indexOf('"demo"') < src.indexOf("studioCatalog(map)"));
  const server = readFileSync("src/lib/audio-studio/server.ts", "utf8");
  assert.match(server, /voiceAvailability\(env, \(m\) => modelRate\(m, env\)\.rate, \{ owner: user\.owner === true \}\)/);
  // Ninguna ruta ni página del estudio construye dependencias sin la cuenta.
  for (const f of ["src/app/api/audio-studio/projects/route.ts", "src/app/api/audio-studio/projects/[id]/route.ts", "src/app/api/audio-studio/projects/[id]/audio/route.ts",
    "src/app/dashboard/audio-studio/page.tsx", "src/app/dashboard/audio-studio/[id]/page.tsx"]) {
    const s = readFileSync(f, "utf8");
    assert.doesNotMatch(s, /studioDeps\(\)/, f);
    assert.match(s, /studioDeps\(user\)/, f);
  }
});
