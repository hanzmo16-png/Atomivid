import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ResultView } from "@/components/video/ResultView";
import { StartErrorNoticeView, captureOutcome } from "@/components/video/StartErrorNotice";
import { classifyRenderError } from "@/lib/video/render-error";
import { SERVICE_CONFIGURATION_MESSAGE } from "@/lib/video/customer-error";
import { MissingEnvVarError, InvalidEnvVarError } from "@/lib/env-errors";
import { GitHubWorkerDispatchError } from "@/lib/worker/github-actions";
import { MAX_RENDER_ATTEMPTS } from "@/lib/video/limits";
import type { StartOutcome } from "@/lib/video/start-outcome";
import type { VideoRequestSummary } from "@/lib/video/request-view";

// CORRECCION-1 of chatgpt-08: the video page composes the start notice and the result view. Both must give one
// coherent instruction, and «No se generó ningún cargo» only appears when the server proved it.
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;
const NOW = Date.parse("2026-10-14T01:00:00Z");
const failed: VideoRequestSummary = {
  id: "22222222-2222-4222-8222-222222222222", mode: "long_form", topic: "Documental", style: "Documental", duration_seconds: 300, language: "es",
  status: "failed", video_path: null, error_message: null, script_json: { beats: [] }, progress_stage: null, render_attempts: 1,
  render_started_at: "2026-10-14T00:55:00Z", created_at: "2026-10-14T00:00:00Z", aspect_ratio: "16:9", long_form_stage: null,
  long_form_progress: null, long_form_confirmed_at: "2026-10-14T00:50:00Z",
};

/** What /dashboard/videos/[id] renders for a request plus the notice carried from the configure page. */
function videoPage(request: VideoRequestSummary, notice: { message: string; outcome: StartOutcome | null } | null) {
  const current = { status: request.status, attempts: request.render_attempts, retryAvailable: request.render_attempts < MAX_RENDER_ATTEMPTS };
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      {notice && <StartErrorNoticeView message={notice.message} outcome={notice.outcome} current={current} />}
      <ResultView request={request} nowMs={NOW} />
    </AppRouterContext.Provider>,
  );
}

const unescape = (html: string) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const IMMEDIATE_RETRY = /Puedes volver a intentarlo con «Reintentar»|Puedes reintentar la misma producción|>Reintentar</;

test("1. configuration / HTTP 401·403·404: support, no immediate retry invitation, no zero-charge claim without proof", () => {
  const messages = [
    `${SERVICE_CONFIGURATION_MESSAGE} (Código: 0a1b2c3d)`,
    classifyRenderError(new MissingEnvVarError("GH_WORKER_TOKEN"), "0a1b2c3d"),
    ...[401, 403, 404].map((s) => classifyRenderError(new GitHubWorkerDispatchError(s, "body"), "0a1b2c3d")),
  ];
  for (const message of messages) {
    const request = { ...failed, error_message: message };
    // Outcome as the route sends it when the reservation release was NOT confirmed.
    const html = unescape(videoPage(request, { message, outcome: { retry: "support", charge: "unknown", status: "failed", attempts: 1 } }));
    assert.match(html, /contacta al soporte con el código antes de volver a intentarlo/, message);
    assert.match(html, /Repetir ahora no lo resolverá/);
    assert.doesNotMatch(html, IMMEDIATE_RETRY, message);
    assert.match(html, /Reintentar tras confirmarlo con soporte/);
    assert.doesNotMatch(html, /No se generó ningún cargo/);
  }
});

test("2. failure proven before start with the reservation released: the zero-charge sentence is allowed", () => {
  const message = "Se alcanzó el límite de peticiones de GitHub. Intenta de nuevo en unos minutos. (Código: 0a1b2c3d)";
  const html = unescape(videoPage({ ...failed, error_message: message }, { message, outcome: { retry: "available", charge: "none_proven", status: "failed", attempts: 1 } }));
  assert.match(html, /No se generó ningún cargo por este intento/);
  assert.match(html, /la producción no se inició/);
  // Supply refused before reserving: the request stays script_ready and the same start is offered again.
  const ready = { ...failed, status: "script_ready", render_attempts: 0 };
  const notice = unescape(videoPage(ready, { message: "Sin capacidad ahora.", outcome: { retry: "available", charge: "none_proven", status: "script_ready", attempts: 0 } }));
  assert.match(notice, /No se generó ningún cargo por este intento\. Puedes volver a pulsar «Iniciar producción»/);
});

test("3. later failure or uncertain consumption: no zero-charge claim, the request is kept, neutral instruction", () => {
  const message = "No se pudo completar la acción. Intenta de nuevo en un momento.";
  for (const outcome of [null, { retry: "available", charge: "unknown", status: "failed", attempts: 1 } as StartOutcome]) {
    const html = unescape(videoPage({ ...failed, error_message: "Fallo del render (Código: 0a1b2c3d)" }, { message, outcome: captureOutcome(outcome, "failed", 1) }));
    assert.doesNotMatch(html, /No se generó ningún cargo|ningún cobro|sin costo/);
    assert.match(html, /Tu solicitud y el plan confirmado siguen guardados/);
    assert.match(html, /no pudo iniciarse con normalidad/);
  }
});

test("4. retryable error: retry offered, reuse of what is stored, possible new cost within the cap, attempt consumed", () => {
  const message = "GitHub Actions tiene un problema temporal (HTTP 502). Intenta de nuevo en unos minutos. (Código: 0a1b2c3d)";
  const html = unescape(videoPage({ ...failed, error_message: message }, { message, outcome: { retry: "available", charge: "unknown", status: "failed", attempts: 1 } }));
  assert.match(html, /Puedes volver a intentarlo con «Reintentar» \(usa uno de los intentos disponibles\)/);
  assert.match(html, />Reintentar</);
  assert.match(html, /Se reutiliza lo que ya quedó guardado de este plan; lo que falte puede tener un costo nuevo, siempre dentro\s+del límite confirmado/);
  assert.match(html, /Cada reintento usa uno de los intentos disponibles/);
  assert.doesNotMatch(html, /tras confirmarlo con soporte|gratis|no se cobra dos veces/);
});

test("5. attempt or state change: the earlier notice is cleared and does not come back on a later failure", () => {
  const message = "GitHub Actions tiene un problema temporal (HTTP 502). Intenta de nuevo en unos minutos. (Código: 0a1b2c3d)";
  const written: StartOutcome = { retry: "available", charge: "none_proven", status: "failed", attempts: 1 };
  assert.match(videoPage({ ...failed, error_message: message }, { message, outcome: written }), /role="alert"[^>]*>[\s\S]*no se inició/);
  // The retry runs (processing, attempt 2), then fails again: the attempt-1 notice must not reappear.
  for (const later of [{ status: "processing", render_attempts: 2 }, { status: "failed", render_attempts: 2 }, { status: "completed", render_attempts: 2 }]) {
    const html = unescape(videoPage({ ...failed, ...later, error_message: "Otro fallo (Código: 9f8e7d6c)" }, { message, outcome: written }));
    assert.doesNotMatch(html, /la producción no se inició|No se generó ningún cargo|HTTP 502/, JSON.stringify(later));
  }
  // Without a server outcome the notice is pinned to the state it was read in.
  const pinned = captureOutcome(null, "failed", 1);
  assert.doesNotMatch(videoPage({ ...failed, render_attempts: 2 }, { message, outcome: pinned }), /no pudo iniciarse con normalidad/);
});

test("6. sanitisation: no customer text names internal variables or secrets", () => {
  const INTERNAL = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
  const texts = [
    classifyRenderError(new MissingEnvVarError("GH_WORKER_TOKEN"), "0a1b2c3d"),
    classifyRenderError(new InvalidEnvVarError("LONG_FORM_REAL_RUN_CONFIRM", "debe ser true"), "0a1b2c3d"),
    ...[401, 403, 404, 422, 429, 502].map((s) => classifyRenderError(new GitHubWorkerDispatchError(s, "GH_WORKER_REPO secret"), "0a1b2c3d")),
  ];
  for (const t of texts) {
    assert.doesNotMatch(t, INTERNAL, t);
    const html = unescape(videoPage({ ...failed, error_message: t }, { message: t, outcome: { retry: "support", charge: "unknown", status: "failed", attempts: 1 } }));
    assert.doesNotMatch(html.replace(/<[^>]+>/g, " "), INTERNAL, t);
  }
});

test("route contract: zero charge only after the queued CAS and a confirmed release; support from the classified message", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", "app", "api", "generate", "[id]", "render", "route.ts"), "utf-8");
  const failPath = source.slice(source.indexOf("await worker.trigger("));
  assert.match(failPath, /charge: "unknown"/, "the worker-failure outcome starts as unknown");
  assert.match(failPath, /failed\?\.length === 1\)[\s\S]*releaseUnusedJobSupply[\s\S]*if \(released\) outcome\.charge = "none_proven"/);
  assert.match(failPath, /retry: requiresSupport\(message\) \? "support" : "available"/);
  assert.match(failPath, /NextResponse\.json\(\{ error: message, outcome \}/);
  assert.match(source, /const nothingReserved: StartOutcome = \{[^}]*charge: "none_proven"[\s\S]*?\};\s*try \{\s*const demands/, "only the pre-reservation refusals reuse nothingReserved");
});
