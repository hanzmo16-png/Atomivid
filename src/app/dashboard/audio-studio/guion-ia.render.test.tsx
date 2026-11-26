/**
 * Guion con IA en el editor (P0 2026-11-25): ya no existe «Generar estructura de guion» con pautas para rellenar; el
 * botón escribe el guion completo con IA, muestra el avance real (pasos guardados) y bloquea la edición mientras escribe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AudioEditor } from "./AudioEditor";
import { AiScriptPanel, scriptPhaseLabel } from "./AiScriptPanel";
import { applyInput, newProject } from "@/lib/audio-studio/model";
import { view } from "@/lib/audio-studio/service";
import { newScriptJob, type ScriptJob } from "@/lib/audio-studio/script-ai";
import { scriptInputOf } from "@/lib/audio-studio/script-service";

const NOW = "2026-11-25T23:30:00.000Z";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000b1";
const base = applyInput(newProject({ id: ID, ownerId: ID, now: NOW, title: "Las líneas y momias de Nazca", voiceCount: 2 }), { notes: "Tono documental riguroso.", targetMinutes: 30 }, NOW);
const plan = { title: "Nazca", blocks: [{ title: "Qué son las líneas", points: ["a", "b"] }, { title: "Para qué se hicieron", points: ["a", "b"] }, { title: "Las momias en disputa", points: ["a", "b"] }] };
const noop = async () => null;

test("editor: sin la plantilla antigua; botón para escribir el guion completo con IA y notas de dirección antes", () => {
  const html = renderToStaticMarkup(<AudioEditor initial={view(base, {})} synthesis="local" scriptAi={{ available: true }} />);
  assert.doesNotMatch(html, /Generar estructura de guion|audio-outline|Reemplaza esta pauta/);
  assert.match(html, /data-testid="audio-ai-write"[^>]*>Escribir el guion completo con IA</);
  assert.ok(html.indexOf('data-testid="audio-notes"') < html.indexOf('data-testid="audio-ai-write"'), "las notas van antes del botón");
  assert.ok(html.indexOf('data-testid="audio-ai-write"') < html.indexOf('data-testid="audio-script"'));
  assert.match(html, /No consume créditos de voz/);
  assert.match(html, /class="[^"]*min-h-11[^"]*"[^>]*data-testid="audio-ai-write"|data-testid="audio-ai-write"[^>]*class="[^"]*min-h-11/);
});

test("IA no disponible: lo dice y no ofrece plantilla", () => {
  const html = renderToStaticMarkup(<AudioEditor initial={view(base, {})} synthesis="local" />);
  assert.match(html, /data-testid="audio-ai-off"/);
  assert.doesNotMatch(html, /audio-ai-write|Generar estructura/);
});

test("en curso: porcentaje de pasos guardados, fase concreta, editor bloqueado", () => {
  const job: ScriptJob = { ...newScriptJob("aaaaaaaa-aaaa-4aaa-8aaa-0000000000c1", scriptInputOf(base), NOW), plan, blocks: [["Voz 1: uno"]] };
  const p = view({ ...base, scriptJob: job }, {});
  const panel = renderToStaticMarkup(<AiScriptPanel project={p} ai={{ available: true }} dirty={false} blocked={false} save={noop} onProject={() => {}} />);
  assert.match(panel, /aria-valuenow="50"/); // escaleta + 1 de 3 bloques = 2 de 4 pasos
  assert.match(panel, /Paso 3 de 4 · Escribiendo la parte 2 de 3: «Para qué se hicieron»/);
  assert.equal(scriptPhaseLabel({ ...job, plan: null, blocks: [] }), "Diseñando la estructura temática del episodio…");
  const editor = renderToStaticMarkup(<AudioEditor initial={p} synthesis="local" scriptAi={{ available: true }} />);
  assert.match(editor, /data-testid="audio-script"[^>]*disabled=""|disabled=""[^>]*data-testid="audio-script"/);
  assert.match(editor, /La IA está escribiendo el guion/);
});

test("terminado: duración escrita frente a la pedida y opción de reescribir con confirmación", () => {
  const job: ScriptJob = { ...newScriptJob("aaaaaaaa-aaaa-4aaa-8aaa-0000000000c2", scriptInputOf(base), NOW), plan, status: "terminado", result: { words: 4400, estimatedMinutes: 29.3, withinTarget: true } };
  const p = view({ ...base, script: "## A\n\nVoz 1: hola\n\nVoz 2: qué tal", scriptJob: job }, {});
  const html = renderToStaticMarkup(<AiScriptPanel project={p} ai={{ available: true }} dirty={false} blocked={false} save={noop} onProject={() => {}} />);
  assert.match(html, /4\.?400 palabras, ≈ 29,3 min para 30 pedidos/);
  assert.match(html, /Reescribir el guion con IA/);
});
