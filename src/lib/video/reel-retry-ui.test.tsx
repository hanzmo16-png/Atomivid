import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { RequestCard } from "@/components/video/RequestCard";
import type { VideoRequestSummary } from "@/lib/video/request-view";

const NOW = Date.parse("2026-10-19T19:00:00Z");
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;
const wrap = (request: VideoRequestSummary) => renderToStaticMarkup(
  <AppRouterContext.Provider value={router}><RequestCard request={request} nowMs={NOW} /></AppRouterContext.Provider>,
);
const base: VideoRequestSummary = {
  id: "11111111-1111-4111-8111-111111111111", mode: "visual", topic: "Reel", style: "Documental",
  duration_seconds: 30, language: "es", status: "failed", video_path: null, error_message: "Render error",
  script_json: { segments: [{ text: "Hola", visualQuery: "vista" }] }, progress_stage: null,
  render_attempts: 1, render_started_at: "2026-10-19T18:00:00Z", created_at: "2026-10-19T17:00:00Z",
};

test("historial: Reel fallido ofrece enlace a revisar el presupuesto; no lanza POST /render", () => {
  const html = wrap(base);
  assert.match(html, /Revisar tope y reintentar/);
  assert.match(html, /href="\/dashboard\/review\/11111111-1111-4111-8111-111111111111"/);
  assert.doesNotMatch(html, /<button[^>]*>Reintentar<\/button>/);
});

test("historial: Reel detenido ofrece revisión; Reel activo o sin guion no ofrece reintento directo", () => {
  const stale = { ...base, status: "processing", render_started_at: "2026-10-19T18:00:00Z" };
  assert.match(wrap(stale), /Revisar tope y reintentar/);
  assert.doesNotMatch(wrap({ ...stale, render_started_at: "2026-10-19T18:59:00Z" }), /Revisar tope y reintentar/);
  assert.doesNotMatch(wrap({ ...base, script_json: null }), /Revisar tope y reintentar/);
});

test("historial: fallo que requiere soporte no ofrece reintento de gasto", () => {
  const html = wrap({ ...base, error_message: "HTTP 403 credential invalid" });
  assert.doesNotMatch(html, /Revisar tope y reintentar/);
  assert.match(html, /Requiere soporte antes de otro intento/);
});
