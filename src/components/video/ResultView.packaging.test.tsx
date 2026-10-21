import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ResultView } from "./ResultView";
import { asDownloadUrl } from "@/lib/storage/download-url";
import type { VideoRequestSummary } from "@/lib/video/request-view";

const request: VideoRequestSummary = {
  id: "panama", mode: "long_form", topic: "Canal de Panamá", style: "documentary",
  duration_seconds: 180, language: "es", status: "completed", video_path: "panama/output/final.mp4",
  error_message: null, script_json: null, progress_stage: null, render_attempts: 1,
  render_started_at: null, created_at: "2026-09-26T00:00:00Z", aspect_ratio: "16:9",
};
const videoUrl = "https://example.com/storage/final.mp4?token=signed%2Btoken";
const thumbnailUrl = "https://example.com/storage/thumbnail.jpg?token=thumbnail-token";
// The completed Long Form result offers "Actualizar enlaces" (router.refresh): it needs a mounted app router.
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;
const renderToStaticMarkupInRouter = (el: React.ReactElement) => renderToStaticMarkup(<AppRouterContext.Provider value={router}>{el}</AppRouterContext.Provider>);

test("descarga conserva la autorización y añade Content-Disposition sin alterar la vista previa", () => {
  const result = new URL(asDownloadUrl(videoUrl, "atomicvid-video.mp4"));
  assert.equal(result.searchParams.get("token"), "signed+token");
  assert.equal(result.searchParams.get("download"), "atomicvid-video.mp4");
  assert.equal(new URL(videoUrl).searchParams.has("download"), false);
});

test("resultado: video y miniatura se visualizan y descargan con enlaces separados", () => {
  const html = renderToStaticMarkupInRouter(<ResultView request={request} videoUrl={videoUrl} thumbnailUrl={thumbnailUrl} thumbnailRequested nowMs={0} />);
  assert.ok(html.includes(`src="${videoUrl}"`));
  assert.ok(html.includes(`src="${thumbnailUrl}"`));
  assert.match(html, /download=atomicvid-video\.mp4/);
  assert.match(html, /download=atomicvid-miniatura\.jpg/);
  assert.match(html, /href="\/dashboard\/long-form\/new"/);
  assert.doesNotMatch(html, /miniatura solicitada no está disponible/);
});

test("miniatura solicitada ausente: aviso visible sin quitar el video ni pedir regenerarlo", () => {
  const html = renderToStaticMarkupInRouter(<ResultView request={request} videoUrl={videoUrl} thumbnailRequested nowMs={0} />);
  assert.match(html, /miniatura solicitada no está disponible/);
  assert.match(html, /No necesitas volver a generar el video/);
  assert.match(html, /Descargar video/);
  const optional = renderToStaticMarkupInRouter(<ResultView request={request} videoUrl={videoUrl} nowMs={0} />);
  assert.doesNotMatch(optional, /miniatura solicitada/);
});
