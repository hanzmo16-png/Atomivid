import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ResultView } from "@/components/video/ResultView";
import { RequestCard } from "@/components/video/RequestCard";
import type { VideoRequestSummary } from "@/lib/video/request-view";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;
const wrap = (el: React.ReactElement) => renderToStaticMarkup(<AppRouterContext.Provider value={router}>{el}</AppRouterContext.Provider>);
const NOW = Date.parse("2026-10-09T12:00:00Z");
const base: VideoRequestSummary = {
  id: "11111111-1111-4111-8111-111111111111", mode: "long_form", topic: "Documental", style: "Documental", duration_seconds: 300, language: "es",
  status: "processing", video_path: null, error_message: null, script_json: { beats: [] }, progress_stage: "queued", render_attempts: 1,
  render_started_at: "2026-10-09T11:55:00Z", created_at: "2026-10-09T11:00:00Z", aspect_ratio: "16:9", long_form_stage: null,
  long_form_progress: null, long_form_confirmed_at: "2026-10-09T11:50:00Z",
};

test("YouTube en espera de capacidad: explica la espera y ofrece reanudar la MISMA producción (página y historial)", () => {
  const waiting = { ...base, supply_wait_started_at: "2026-10-09T11:56:00Z", error_message: "Estamos esperando disponibilidad de producción. Tu solicitud y sus avances están guardados." };
  const page = wrap(<ResultView request={waiting} nowMs={NOW} />);
  assert.match(page, /En espera de capacidad de producción/);
  assert.match(page, /Reanudar ahora/);
  assert.match(page, /lo ya pagado se reutiliza/);
  assert.doesNotMatch(page, /Reintentar/, "waiting is not a failure: no new attempt is offered");
  assert.match(wrap(<RequestCard request={waiting} nowMs={NOW} />), /Reanudar/);
});

test("YouTube fallido con plan confirmado: la página del video ofrece Reintentar (antes solo el historial)", () => {
  const failed = { ...base, status: "failed", progress_stage: null, error_message: "Fallo del render (Código: abc123)" };
  const page = wrap(<ResultView request={failed} nowMs={NOW} />);
  assert.match(page, /No se pudo generar este video/);
  assert.match(page, /Reintentar/);
  assert.match(page, /no se cobra dos veces/);
  const exhausted = wrap(<ResultView request={{ ...failed, render_attempts: 99 }} nowMs={NOW} />);
  assert.doesNotMatch(exhausted, /Reintentar/);
  assert.match(exhausted, /máximo de intentos/);
  const unconfirmed = wrap(<ResultView request={{ ...failed, long_form_confirmed_at: null }} nowMs={NOW} />);
  assert.doesNotMatch(unconfirmed, /Reintentar/, "without a confirmed plan the render route would refuse it");
});

test("YouTube en curso con latido reciente: progreso, sin reintento ni reanudar (no se duplica trabajo)", () => {
  const running = { ...base, long_form_stage: "voice", long_form_progress: { stage: "voice", done: 1, total: 5, updatedAt: "2026-10-09T11:59:00Z" } };
  const page = wrap(<ResultView request={running} nowMs={NOW} />);
  assert.doesNotMatch(page, /Reintentar|Reanudar/);
});

test("Completado sin archivo reproducible: nunca muestra reproductor ni descarga", () => {
  const page = wrap(<ResultView request={{ ...base, status: "completed", progress_stage: null, video_path: "x/output/final.mp4" }} videoUrl={null} nowMs={NOW} />);
  assert.doesNotMatch(page, /<video|Descargar video/);
  assert.match(page, /No se pudo generar el enlace de descarga/);
});
