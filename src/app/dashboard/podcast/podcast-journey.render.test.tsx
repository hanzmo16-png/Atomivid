// Recorrido de componentes REALES del podcast (render estático, servicios fuera): crear → revisar → volver; producir →
// revisar → confirmar/volver. No es un recorrido HTTP/DB real.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { NewEpisode } from "./NewEpisode";
import { VideoPanel } from "./[id]/VideoPanel";

const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const render = (node: ReactNode) => renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>);
const voices = [{ voiceId: "v1", name: "Lucía", language: "es", accent: null, gender: null, previewUrl: null }] as never;
const draft = { v: 2 as const, owner: "user-a", mode: "tts" as const, title: "Caso Roswell", script: "Este es el guion completo del episodio de prueba.", language: "es" as const, voiceId: "v1" };

test("crear: el formulario lleva a revisar (no crea directo) y declara un solo narrador", () => {
  const html = render(<NewEpisode ownerId="user-a" voices={voices} voicesError={null} usdPer1kChars={0.3} maxChars={50000} initialDraft={draft} />);
  assert.match(html, /Revisar antes de crear/);
  assert.doesNotMatch(html, /Crear episodio \(no genera ni cobra\)/);
  assert.match(html, /un narrador/);
  assert.ok(html.includes(draft.script), "el guion del borrador está en el formulario");
});

test("crear → revisar: resumen con la configuración elegida, crear y volver sin perder datos", () => {
  const html = render(<NewEpisode ownerId="user-a" voices={voices} voicesError={null} usdPer1kChars={0.3} maxChars={50000} initialDraft={draft} initialStep="review" />);
  assert.match(html, /Revisa el episodio/);
  assert.match(html, /Caso Roswell/); assert.match(html, /voz guardada «Lucía»/); assert.match(html, /Español/);
  assert.ok(html.includes(draft.script), "el guion revisado es el escrito");
  assert.match(html, /Crear episodio \(no genera ni cobra\)/); assert.match(html, /Volver a editar/);
});

test("crear: sin voz válida o con guion corto no se puede pasar a revisar", () => {
  const html = render(<NewEpisode ownerId="user-a" voices={voices} voicesError={null} usdPer1kChars={0.3} maxChars={50000} initialDraft={{ ...draft, script: "corto" }} />);
  assert.match(html, /<button[^>]*disabled[^>]*>Revisar antes de crear/);
  const sinVoz = render(<NewEpisode ownerId="user-a" voices={[] as never} voicesError="No se pudieron consultar las voces." usdPer1kChars={0.3} maxChars={50000} initialDraft={draft} />);
  assert.match(sinVoz, /No se pudieron consultar las voces/); assert.match(sinVoz, /<button[^>]*disabled[^>]*>Revisar antes de crear/);
});

const panel = (over: Record<string, unknown> = {}) => (
  <VideoPanel episodeId="e1" status="none" stage={null} stalled={false} error={null} canRequest playUrl={null} downloadUrl={null} sizeMb={null} minutes={null}
    remainingUsd={1.2} budgetUsd={3} scheduledAt={null} spentUsd={null} historicalUsd={0} runBudgetUsd={null} minimumRunUsd={1.5} runColumn seconds={null} checks={null}
    reviewStatus="pending" reviewNote={null} publishStatus="held"
    review={{ id: "e1", title: "Caso Roswell", language: "es", source: "tts", script: null, voice_id: "v1", voice_name: "Lucía", status: "draft" }} confirmToken="tok" {...over} />
);

test("producir: el botón lleva a revisar; no se envía nada sin confirmar", () => {
  const html = render(panel());
  assert.match(html, /Revisar y producir/); assert.doesNotMatch(html, /Confirmar y producir/);
});

test("producir → revisar: resumen de la configuración visible, confirmar o volver (los valores siguen en el formulario)", () => {
  const html = render(panel({ initialReview: { schedule: false } }));
  assert.match(html, /Revisa antes de producir/);
  assert.match(html, /voz guardada «Lucía»/); assert.match(html, /USD 3\.00/); assert.match(html, /USD 1\.50/); assert.match(html, /ahora/);
  assert.match(html, /Confirmar y producir/); assert.match(html, /Volver a editar/);
  assert.doesNotMatch(html, /Presupuesto total del episodio \(USD\)/, "el formulario se oculta mientras se revisa; su estado se conserva en el componente");
});

test("entrega: estados de bloqueo legibles y descarga del MP4 del mismo episodio cuando existe", () => {
  const blocked = render(panel({ status: "blocked", error: "El montaje con el Director no está disponible (DIRECTOR_RIGHTS_UNAVAILABLE)." }));
  assert.match(blocked, /Detenida: El montaje con el Director/); assert.match(blocked, /Revisar y reintentar/);
  const ready = render(panel({ status: "ready", playUrl: "https://x/e1.mp4", downloadUrl: "https://x/e1.mp4?download=Caso.mp4", sizeMb: 12, minutes: 3, seconds: 180 }));
  assert.match(ready, /Revisión de la entrega/); assert.match(ready, /href="https:\/\/x\/e1.mp4\?download=Caso.mp4"/); assert.match(ready, /Aprobar para publicar/);
});
