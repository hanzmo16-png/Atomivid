import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ResultView } from "@/components/video/ResultView";
import { RequestCard } from "@/components/video/RequestCard";
import { ProductionProgressCard } from "@/components/video/ProductionProgressCard";
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

test("en curso: la etapa se nombra y el historial abre el mismo proyecto", () => {
  const running = {
    ...base,
    long_form_stage: "assets",
    long_form_progress: {
      stage: "assets", unitsCompleted: 4, unitsTotal: 10, unitLabel: "escenas", updatedAt: "2026-10-09T11:59:00Z",
    },
  };
  const card = wrap(<RequestCard request={running} nowMs={NOW} />);
  assert.match(card, /Etapa: Preparando imágenes y video por escena/);
  assert.match(card, /data-testid="open-project"/);
  assert.match(card, /href="\/dashboard\/videos\/11111111-1111-4111-8111-111111111111"/);
  assert.match(card, /\d+%/);
  const page = renderToStaticMarkup(
    <ProductionProgressCard longFormStage="assets" longFormProgress={running.long_form_progress} nowMs={NOW} />,
  );
  assert.match(page, /Etapa actual/);
  assert.match(page, /Preparando imágenes y video por escena/);
  assert.match(page, /progressbar/);
});

test("detenido: hay etapa y camino al proyecto, y ni la tarjeta ni la página inventan un porcentaje", () => {
  const stalled = {
    ...base,
    render_started_at: "2026-10-09T10:00:00Z",
    long_form_stage: "rendering",
    long_form_progress: {
      stage: "rendering", unitsCompleted: 100, unitsTotal: 100, unitLabel: "fotogramas",
      updatedAt: "2026-10-09T10:30:00Z", stageStartedAt: "2026-10-09T10:00:00Z",
    },
  };
  const card = wrap(<RequestCard request={stalled} nowMs={NOW} />);
  assert.match(card, /Última etapa: Renderizando el documental/);
  assert.match(card, /Sin porcentaje/);
  assert.match(card, /Abrir proyecto/);
  assert.doesNotMatch(card, /\d+%/);
  assert.doesNotMatch(card, /progressbar/);
  const page = wrap(<ResultView request={stalled} nowMs={NOW} />);
  assert.match(page, /Última etapa: Renderizando el documental/);
  assert.match(page, /dejó de reportar avances/);
  assert.doesNotMatch(page, /progressbar/);
  assert.doesNotMatch(page, /\d+%/);
});

test("listo: reproducir y descargar quedan juntos, con la duración medida si no es la pedida", () => {
  const done = { ...base, status: "completed" as const, progress_stage: null, video_path: "x/output/final.mp4" };
  const videoUrl = "https://example.com/storage/final.mp4?token=signed";
  const page = wrap(<ResultView request={done} videoUrl={videoUrl} deliveredDurationSeconds={272.085} nowMs={NOW} />);
  assert.match(page, /data-testid="result-actions"[\s\S]*Reproducir[\s\S]*Descargar video/);
  assert.match(page, /download=atomicvid-video\.mp4/);
  assert.match(page, /token=signed/);
  assert.match(page, /data-testid="measured-duration"/);
  assert.match(page, /Duración del archivo: 4 min 32 s \(pedido 5 min\)/);
  const same = wrap(<ResultView request={done} videoUrl={videoUrl} deliveredDurationSeconds={300} nowMs={NOW} />);
  assert.match(same, /Reproducir/);
  assert.match(same, /Descargar video/);
  assert.doesNotMatch(same, /data-testid="measured-duration"/);
  const card = wrap(<RequestCard request={done} videoUrl={videoUrl} nowMs={NOW} />);
  assert.match(card, /Abrir proyecto/);
  assert.doesNotMatch(card, /Ver detalles/);
});

test("un Reel terminado sigue ofreciendo Ver detalles y no el camino de Long Form", () => {
  const reel: VideoRequestSummary = { ...base, mode: "visual", aspect_ratio: "9:16", status: "completed", video_path: "x/out.mp4" };
  const card = wrap(<RequestCard request={reel} videoUrl="https://example.com/storage/reel.mp4?token=signed" nowMs={NOW} />);
  assert.match(card, /Ver detalles/);
  assert.doesNotMatch(card, /Abrir proyecto/);
});
