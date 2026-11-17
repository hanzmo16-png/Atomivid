import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AudioEditor, type Synthesis } from "./AudioEditor";
import { applyInput, newProject, type AudioProject } from "@/lib/audio-studio/model";
import { view } from "@/lib/audio-studio/service";
import { voiceAvailability } from "@/lib/audio-studio/voice";
import { SEED_EPISODE } from "@/lib/audio-studio/seed";

/** T-20261116-2013: con la síntesis real inactiva la interfaz no ofrece gasto ni generación. USD 0, sin red. */
const A = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-16T12:00:00.000Z";
const project = (patch: Partial<AudioProject> = {}) => {
  const p = applyInput(newProject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000009", ownerId: A, now: NOW, title: SEED_EPISODE.title }), {
    voices: [SEED_EPISODE.voice], targetMinutes: 18, script: SEED_EPISODE.script, music: SEED_EPISODE.music, budgetUsd: SEED_EPISODE.budgetUsd,
  }, NOW);
  return view({ ...p, ...patch }, {});
};
const html = (synthesis: Synthesis | null, patch?: Partial<AudioProject>) => renderToStaticMarkup(<AudioEditor initial={project(patch)} synthesis={synthesis} />);
const PAID = ["audio-authorize", "audio-generate"];

test("síntesis inactiva: aviso claro desde el primer render; sin autorización de gasto ni «Generar MP3»", () => {
  const h = html("inactiva");
  assert.match(h, /data-testid="audio-voice-disabled"/);
  assert.match(h, /todavía no está activada/);
  assert.match(h, /no se hará ningún cargo/);
  for (const id of PAID) assert.doesNotMatch(h, new RegExp(`data-testid="${id}"`), id);
  assert.doesNotMatch(h, /Autorizo un gasto/);
});

test("síntesis inactiva: edición, guardado y archivo siguen disponibles; voces seleccionables sin marcarse «no disponible»", () => {
  const h = html("inactiva");
  for (const id of ["audio-title", "audio-script", "audio-save", "audio-archive", "audio-voice-0", "audio-language"]) assert.match(h, new RegExp(`data-testid="${id}"`), id);
  assert.doesNotMatch(h, /no disponible con este modelo/);
  assert.doesNotMatch(h, /Elige voces disponibles para este modelo/);
});

test("síntesis inactiva: un episodio archivado conserva «Restaurar»; uno fallido no ofrece «Reanudar»", () => {
  assert.match(html("inactiva", { archivedAt: NOW }), /data-testid="audio-restore"/);
  const failed = html("inactiva", { generation: { ...project().generation, status: "fallida", error: "Falló el proveedor." } });
  assert.doesNotMatch(failed, /data-testid="audio-resume"/);
  assert.match(failed, /data-testid="audio-voice-disabled"/);
});

test("síntesis real: el flujo fusionado no cambia (autorización exacta + «Generar MP3» deshabilitado hasta autorizar)", () => {
  const h = html("real");
  assert.doesNotMatch(h, /data-testid="audio-voice-disabled"/);
  assert.doesNotMatch(h, /data-testid="audio-voice-local"/);
  assert.match(h, /Autorizo un gasto de hasta <strong[^>]*>USD 3\.\d\d<\/strong>/);
  assert.match(h, /data-testid="audio-generate"[^>]*disabled|disabled[^>]*data-testid="audio-generate"/);
  const failed = html("real", { generation: { ...project().generation, status: "fallida", error: "x" } });
  assert.match(failed, /data-testid="audio-resume"/);
});

test("síntesis local: nota de voz de prueba y mismo flujo de autorización", () => {
  const h = html("local");
  assert.match(h, /data-testid="audio-voice-local"/);
  for (const id of PAID) assert.match(h, new RegExp(`data-testid="${id}"`), id);
});

test("estado aún desconocido: no se ofrece gasto hasta que el servidor confirme la síntesis", () => {
  const h = html(null);
  for (const id of PAID) assert.doesNotMatch(h, new RegExp(`data-testid="${id}"`), id);
  assert.match(h, /Comprobando voces disponibles/);
});

test("matriz de disponibilidad (fuente única del servidor): solo «real» con interruptor + mapa; «local» nunca en producción", () => {
  const map = "es-latam-m-profesional=AAAAAAAA1,es-latam-m-calida=AAAAAAAA2,es-latam-f-profesional=AAAAAAAA3,es-latam-f-energica=AAAAAAAA4";
  assert.equal(voiceAvailability({}).ok, false);
  assert.equal(voiceAvailability({ AUDIO_STUDIO_ELEVENLABS_VOICES: map }).ok, false);
  assert.equal(voiceAvailability({ AUDIO_STUDIO_PAID_TTS: "1" }).ok, false);
  const real = voiceAvailability({ AUDIO_STUDIO_PAID_TTS: "1", AUDIO_STUDIO_ELEVENLABS_VOICES: map });
  assert.ok(real.ok && real.voice.mode === "elevenlabs");
  const local = voiceAvailability({ AUDIO_STUDIO_VOICE: "fixture" });
  assert.ok(local.ok && local.voice.mode === "fixture");
  assert.equal(voiceAvailability({ AUDIO_STUDIO_VOICE: "fixture", VERCEL: "1" }).ok, false);
  assert.equal(voiceAvailability({ AUDIO_STUDIO_VOICE: "fixture", NODE_ENV: "production" }).ok, false);
});

test("ruta de voces: con síntesis inactiva responde «inactiva» antes de consultar al proveedor y sin exponer configuración", () => {
  const src = readFileSync("src/app/api/audio-studio/voices/route.ts", "utf8");
  const inactive = src.indexOf('synthesis: "inactiva"');
  assert.ok(inactive > 0 && inactive < src.indexOf("studioCatalog(map)"), "«inactiva» se decide antes de llamar al catálogo");
  assert.ok(src.indexOf("audioStudioUser()") < src.indexOf("voiceAvailability(process.env)"), "la sesión se exige antes que todo");
  assert.match(src, /voiceAvailability\(process\.env\)/);
  // Nunca devuelve valores de variables ni el motivo interno de la indisponibilidad.
  assert.doesNotMatch(src, /availability\.reason|process\.env\.[A-Z_]+\s*[,}]|JSON\.stringify\(process\.env/);
});
