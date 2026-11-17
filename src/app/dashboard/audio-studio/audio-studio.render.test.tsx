import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AudioLibrary } from "./AudioLibrary";
import { AudioEditor } from "./AudioEditor";
import { applyInput, newProject } from "@/lib/audio-studio/model";
import { view } from "@/lib/audio-studio/service";
import { SEED_EPISODE } from "@/lib/audio-studio/seed";

const A = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-16T12:00:00.000Z";
const seed = () => view(applyInput(newProject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", ownerId: A, now: NOW, title: SEED_EPISODE.title }), {
  voices: [SEED_EPISODE.voice], targetMinutes: 18, script: SEED_EPISODE.script, notes: SEED_EPISODE.notes, music: SEED_EPISODE.music, budgetUsd: SEED_EPISODE.budgetUsd,
}, NOW), {});

test("biblioteca de audio: título, voces, duración, costo estimado, tope, gastado USD 0.00 y estado", () => {
  const html = renderToStaticMarkup(<AudioLibrary projects={[seed()]} archived={false} />);
  assert.match(html, /El día que entiendes que no puedes controlarlo todo/);
  assert.match(html, /1 voz · Víctor · objetivo 18 min/);
  assert.match(html, /Costo estimado USD 3\.\d\d · tope USD 6\.00 · gastado USD 0\.00/);
  assert.match(html, /Borrador/);
  assert.match(html, /href="\/dashboard\/audio-studio\/aaaaaaaa-aaaa-4aaa-8aaa-000000000001"/);
  assert.doesNotMatch(html, /<audio|<video/);
});

test("biblioteca vacía y archivados vacíos tienen su mensaje", () => {
  assert.match(renderToStaticMarkup(<AudioLibrary projects={[]} archived={false} />), /Aún no tienes episodios de audio/);
  assert.match(renderToStaticMarkup(<AudioLibrary projects={[]} archived />), /No hay episodios archivados/);
});

test("editor: guion, voces, música inteligente con plan por sección, presupuesto y generación real explicada", () => {
  const html = renderToStaticMarkup(<AudioEditor initial={seed()} synthesis="real" />);
  assert.match(html, /data-testid="audio-script"/);
  assert.match(html, /Víctor — masculina/);
  assert.match(html, /Latinoamericano/);
  assert.match(html, /Plan musical por sección \(1[0-9]\)/);
  assert.match(html, /data-testid="audio-estimated-usd">USD 3\.\d\d</);
  assert.match(html, /data-testid="audio-spent-usd">USD 0\.00</);
  assert.match(html, /data-testid="audio-readiness-ok"/);
  assert.match(html, /Autorizo un gasto de hasta <strong[^>]*>USD 3\.\d\d<\/strong>/);
  assert.match(html, /data-testid="audio-authorize"/);
  assert.match(html, /Generar MP3/);
  assert.match(html, /Sin generar/);
  assert.match(html, /Guardado/);
  // Botones táctiles de 44 px como mínimo.
  for (const id of ["audio-save", "audio-ready", "audio-generate", "audio-archive"]) assert.match(html, new RegExp(`class="[^"]*min-h-11[^"]*"[^>]*data-testid="${id}"|data-testid="${id}"[^>]*class="[^"]*min-h-11`), id);
});

test("editor con dos voces muestra los dos selectores y la ayuda «Voz 1: / Voz 2:»", () => {
  const p = view(applyInput(newProject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002", ownerId: A, now: NOW, title: "Dúo" }), { voiceCount: 2 }, NOW), {});
  const html = renderToStaticMarkup(<AudioEditor initial={p} />);
  assert.match(html, /data-testid="audio-voice-0"/);
  assert.match(html, /data-testid="audio-voice-1"/);
  assert.match(html, /«Voz 1:» o «Voz 2:»/);
});
