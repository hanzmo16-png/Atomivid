import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ResultView } from "./ResultView";
import type { VideoRequestSummary } from "@/lib/video/request-view";

const base = { id: "33333333-3333-4333-8333-333333333333", mode: "long_form", topic: "Canal de Panamá", style: "documentary", duration_seconds: 1800,
  language: "es", status: "completed", video_path: "33333333/output/final.mp4", error_message: null, script_json: null, progress_stage: null,
  render_attempts: 1, render_started_at: null, created_at: new Date(0).toISOString(), aspect_ratio: "16:9", long_form_stage: null,
  long_form_progress: null, long_form_confirmed_at: new Date(0).toISOString() } as unknown as VideoRequestSummary;
const videoUrl = "https://example.com/storage/final.mp4?token=t1";
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;
const render = (r: Partial<VideoRequestSummary>, url: string | null = videoUrl) =>
  renderToStaticMarkup(<AppRouterContext.Provider value={router}><ResultView request={{ ...base, ...r }} videoUrl={url} nowMs={0} /></AppRouterContext.Provider>);

test("Long Form completado: ofrece Actualizar enlaces junto al resultado, sin reiniciar la producción", () => {
  const html = render({});
  assert.match(html, /data-testid="refresh-links"/);
  assert.match(html, /Actualizar enlaces/);
  assert.match(html, /no se vuelve a producir el video/);
  assert.match(html, /Descargar video/);
  assert.doesNotMatch(html, /\/render|\/resume|Reintentar|Iniciar producción|Generando/);
});

test("Long Form completado sin enlace firmado: aviso + acción reintentable, nunca regenerar", () => {
  const html = render({}, null);
  assert.match(html, /No se pudo generar el enlace de descarga/);
  assert.match(html, /data-testid="refresh-links"/);
  assert.match(html, /Puedes intentarlo otra vez/);
  assert.doesNotMatch(html, /\/render|\/resume|Generando/);
});

test("Reel, Avatar y Long Form sin terminar conservan su flujo: no muestran Actualizar enlaces", () => {
  for (const r of [{ mode: "visual", aspect_ratio: "9:16" }, { mode: "avatar", aspect_ratio: "9:16" }] as Partial<VideoRequestSummary>[]) {
    assert.doesNotMatch(render(r), /refresh-links/, String(r.mode));
    assert.doesNotMatch(render(r, null), /refresh-links/, String(r.mode) + " sin enlace");
  }
  for (const status of ["processing", "failed", "script_ready"] as const)
    assert.doesNotMatch(render({ status, video_path: null }, null), /refresh-links/, status);
});

test("Long Form completado: reproductor, descarga y miniatura usan los enlaces firmados del servidor", () => {
  const thumb = "https://example.com/storage/thumb.jpg?token=t1";
  const html = renderToStaticMarkup(<AppRouterContext.Provider value={router}><ResultView request={base} videoUrl={videoUrl} thumbnailUrl={thumb} nowMs={0} /></AppRouterContext.Provider>);
  assert.match(html, /<video[^>]*data-testid="result-video"/);
  assert.match(html, /<video[^>]*src="https:\/\/example\.com\/storage\/final\.mp4\?token=t1"/);
  assert.match(html, /<img[^>]*src="https:\/\/example\.com\/storage\/thumb\.jpg\?token=t1"/);
  assert.match(html, /data-testid="refresh-status" data-state="idle"/);
  assert.equal((html.match(/<video/g) ?? []).length, 1, "un solo reproductor");
});
