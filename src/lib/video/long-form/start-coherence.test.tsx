import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ResultView } from "@/components/video/ResultView";
import { RequestCard } from "@/components/video/RequestCard";
import { StartErrorNotice, StartOutcomeProvider, captureOutcome, type StoredStart } from "@/components/video/StartErrorNotice";
import { classifyRenderError, classifyRenderFailure } from "@/lib/video/render-error";
import { preReservationFailure } from "@/lib/video/start-failure";
import { encodeStoredFailure } from "@/lib/video/failure-action";
import { describeStoredFailure, renderFailureMessage } from "@/lib/video/job-error";
import { SERVICE_CONFIGURATION_MESSAGE } from "@/lib/video/customer-error";
import { MissingEnvVarError, InvalidEnvVarError } from "@/lib/env-errors";
import { GitHubWorkerDispatchError } from "@/lib/worker/github-actions";
import { MAX_RENDER_ATTEMPTS } from "@/lib/video/limits";
import type { StartOutcome } from "@/lib/video/start-outcome";
import type { VideoRequestSummary } from "@/lib/video/request-view";

// chatgpt-08 C1 + C2: the video page composes the start notice and the result view inside one provider. Support is
// decided only by typed data (the route's outcome, or the action the server stored with the failure), never by the
// wording; «No se generó ningún cargo» appears only when the server proved it.
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;
const NOW = Date.parse("2026-10-14T02:00:00Z");
const failed: VideoRequestSummary = {
  id: "22222222-2222-4222-8222-222222222222", mode: "long_form", topic: "Documental", style: "Documental", duration_seconds: 300, language: "es",
  status: "failed", video_path: null, error_message: null, script_json: { beats: [] }, progress_stage: null, render_attempts: 1,
  render_started_at: "2026-10-14T01:55:00Z", created_at: "2026-10-14T01:00:00Z", aspect_ratio: "16:9", long_form_stage: null,
  long_form_progress: null, long_form_confirmed_at: "2026-10-14T01:50:00Z",
};
const ready: VideoRequestSummary = { ...failed, status: "script_ready", render_attempts: 0, render_started_at: null };

/** What /dashboard/videos/[id] renders: provider → notice + result view (same composition as page.tsx). */
function videoPage(request: VideoRequestSummary, carried: { message: string; outcome: StartOutcome | null } | null) {
  const initial: StoredStart | null = carried && { message: carried.message, outcome: captureOutcome(carried.outcome, request.status, request.render_attempts) };
  const supportRequired = request.status === "failed" && Boolean(request.error_message) && describeStoredFailure(request.error_message!).action === "support";
  return unescape(renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <StartOutcomeProvider requestId={request.id} status={request.status} attempts={request.render_attempts} initial={initial}>
        <StartErrorNotice retryAvailable={request.render_attempts < MAX_RENDER_ATTEMPTS} supportRequired={supportRequired} />
        <ResultView request={request} nowMs={NOW} />
      </StartOutcomeProvider>
    </AppRouterContext.Provider>,
  ));
}
const unescape = (html: string) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const START_OR_RETRY_BUTTON = /<button[^>]*>(Iniciar producción|Reintentar)[^<]*<\/button>/;
const IMMEDIATE_RETRY = /Puedes volver a intentarlo con «Reintentar»|Puedes reintentar la misma producción|Puedes volver a pulsar «Iniciar producción»/;

test("C2-1. script_ready + support: support instruction, no «Iniciar producción» and no immediate retry", () => {
  const { body } = preReservationFailure(new MissingEnvVarError("GH_WORKER_TOKEN"), { retry: "available", charge: "none_proven", status: "script_ready", attempts: 0 });
  const html = videoPage(ready, { message: body.error, outcome: body.outcome });
  assert.match(html, /contacta al soporte con el código antes de volver a intentarlo/);
  assert.doesNotMatch(html, START_OR_RETRY_BUTTON);
  assert.doesNotMatch(html, IMMEDIATE_RETRY);
  assert.match(html, /Repetir ahora no lo resolverá\. Contacta al soporte con el código/);
  // Without the support outcome the same page offers the normal start (control check of the matcher).
  assert.match(videoPage(ready, null), START_OR_RETRY_BUTTON);
});

test("C2-2. missing configuration before reserving: typed fields, status and attempts unchanged, none_proven", () => {
  const unchanged: StartOutcome = { retry: "available", charge: "none_proven", status: "script_ready", attempts: 0 };
  for (const error of [new MissingEnvVarError("GH_WORKER_TOKEN"), new InvalidEnvVarError("RENDER_WORKER", "github|inline")]) {
    const { body, status } = preReservationFailure(error, unchanged);
    assert.equal(status, 500);
    assert.deepEqual(body.outcome, { retry: "support", charge: "none_proven", status: "script_ready", attempts: 0 });
    assert.doesNotMatch(body.error, /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
  }
  // The route resolves the worker inside that guard, after reading the request and BEFORE reserving or updating.
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", "app", "api", "generate", "[id]", "render", "route.ts"), "utf-8");
  const guard = source.indexOf("worker = getRenderWorker();");
  assert.ok(guard > 0 && source.indexOf("preReservationFailure(error, nothingReserved)") > guard);
  assert.ok(guard < source.indexOf("await reserveJobSupply(") && guard < source.indexOf('status: "processing",'));
  assert.match(source, /const nothingReserved: StartOutcome = \{ retry: "available", charge: "none_proven", status: videoRequest\.status, attempts: videoRequest\.render_attempts \}/);
});

test("C2-3. the support decision does not depend on wording, case or language", () => {
  // Typed support with text that never says «Contacta al soporte» (English, lower case): still support.
  const english = videoPage(ready, { message: "worker configuration missing. please contact support.", outcome: { retry: "support", charge: "none_proven", status: "script_ready", attempts: 0 } });
  assert.doesNotMatch(english, START_OR_RETRY_BUTTON);
  const stored = { ...failed, error_message: encodeStoredFailure("service misconfigured (Code: 0a1b2c3d)", "support") };
  assert.doesNotMatch(videoPage(stored, null), START_OR_RETRY_BUTTON);
  assert.doesNotMatch(videoPage(stored, null), /\[\[action:support\]\]/, "the machine tag is never shown");
  // The exact Spanish phrase WITHOUT a typed support action: the normal retry stays available.
  const phrase = "Contacta al soporte si el problema continúa. (Código: 0a1b2c3d)";
  const html = videoPage({ ...failed, error_message: phrase }, { message: phrase, outcome: { retry: "available", charge: "unknown", status: "failed", attempts: 1 } });
  assert.match(html, START_OR_RETRY_BUTTON);
  assert.match(html, /Puedes volver a intentarlo con «Reintentar»/);
  // The classifier's action comes from the error type, not from its message.
  assert.equal(classifyRenderFailure(new GitHubWorkerDispatchError(403, "x"), "0a1b2c3d").action, "support");
  assert.equal(classifyRenderFailure(new GitHubWorkerDispatchError(502, "x"), "0a1b2c3d").action, "retry");
});

test("C2-4a. regression failed + support (stored action): support text, no retry button, no zero-charge claim", () => {
  for (const error of [new MissingEnvVarError("GH_WORKER_TOKEN"), ...[401, 403, 404].map((s) => new GitHubWorkerDispatchError(s, "body"))]) {
    const { message, action } = classifyRenderFailure(error, "0a1b2c3d");
    const request = { ...failed, error_message: encodeStoredFailure(message, action) };
    const html = videoPage(request, { message, outcome: { retry: "support", charge: "unknown", status: "failed", attempts: 1 } });
    assert.match(html, /contacta al soporte con el código antes de volver a intentarlo/, message);
    assert.doesNotMatch(html, START_OR_RETRY_BUTTON, message);
    assert.doesNotMatch(html, /No se generó ningún cargo/);
    // History card: same stored action, same decision.
    const card = unescape(renderToStaticMarkup(<AppRouterContext.Provider value={router}><RequestCard request={request} nowMs={NOW} /></AppRouterContext.Provider>));
    assert.doesNotMatch(card, START_OR_RETRY_BUTTON);
    assert.match(card, /Requiere soporte antes de otro intento/);
  }
  // The worker's own configuration failure is stored with the same typed action.
  assert.equal(describeStoredFailure(encodeStoredFailure(`${SERVICE_CONFIGURATION_MESSAGE} (Código: 0a1b2c3d)`, "support")).action, "support");
});

test("C2-4b. regression retryable error: retry offered with reuse/cost/attempt wording; proven zero charge only with none_proven", () => {
  const message = classifyRenderError(new GitHubWorkerDispatchError(502, "x"), "0a1b2c3d");
  const html = videoPage({ ...failed, error_message: message }, { message, outcome: { retry: "available", charge: "none_proven", status: "failed", attempts: 1 } });
  assert.match(html, START_OR_RETRY_BUTTON);
  assert.match(html, /No se generó ningún cargo por este intento\. Puedes volver a intentarlo con «Reintentar» \(usa uno de los intentos disponibles\)/);
  assert.match(html, /lo que falte puede tener un costo nuevo, siempre dentro\s+del límite confirmado/);
  const card = unescape(renderToStaticMarkup(<AppRouterContext.Provider value={router}><RequestCard request={{ ...failed, error_message: message }} nowMs={NOW} /></AppRouterContext.Provider>));
  assert.match(card, START_OR_RETRY_BUTTON);
});

test("C2-4c. regression unknown consumption: neutral text, never «sin cargo» or «no se inició»", () => {
  for (const outcome of [null, { retry: "available", charge: "unknown", status: "failed", attempts: 1 } as StartOutcome]) {
    const html = videoPage({ ...failed, error_message: "Fallo del render (Código: 0a1b2c3d)" }, { message: "No se pudo completar la acción.", outcome });
    assert.doesNotMatch(html, /No se generó ningún cargo|ningún cobro|no se inició/);
    assert.match(html, /Tu solicitud y el plan confirmado siguen guardados/);
    assert.match(html, /no pudo iniciarse con normalidad/);
  }
});

test("C2-4d. regression successful path: no notice, normal start or progress", () => {
  assert.doesNotMatch(videoPage(ready, null), /role="alert"/);
  assert.match(videoPage(ready, null), /<button[^>]*>Iniciar producción/);
  const running = videoPage({ ...failed, status: "processing", progress_stage: "queued", render_attempts: 1 }, null);
  assert.doesNotMatch(running, /role="alert"|Reintentar|Iniciar producción/);
});

test("C2-5. request/state/attempt change: the old notice and its support hold do not contaminate the next state", () => {
  const supportAt0: StartOutcome = { retry: "support", charge: "none_proven", status: "script_ready", attempts: 0 };
  // Support fixed the configuration and the owner started again: processing/1, then a retryable failure at attempt 1.
  for (const later of [{ status: "processing", render_attempts: 1, progress_stage: "queued" }, { status: "failed", render_attempts: 1 }]) {
    const html = videoPage({ ...failed, ...later, error_message: "Otro fallo temporal (Código: 9f8e7d6c)" }, { message: "config", outcome: supportAt0 });
    assert.doesNotMatch(html, /contacta al soporte con el código antes de volver a intentarlo|Repetir ahora no lo resolverá/, JSON.stringify(later));
    if (later.status === "failed") assert.match(html, START_OR_RETRY_BUTTON);
  }
  // A different request never sees it: the provider is keyed by request id and reads only its own entry.
  const other = videoPage({ ...ready, id: "33333333-3333-4333-8333-333333333333" }, null);
  assert.match(other, /<button[^>]*>Iniciar producción/);
});

test("C2-6. sanitisation and display: no internal names, no machine tag in any customer text", () => {
  const INTERNAL = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
  const errors = [new MissingEnvVarError("GH_WORKER_TOKEN"), new InvalidEnvVarError("LONG_FORM_REAL_RUN_CONFIRM", "debe ser true"),
    ...[401, 403, 404, 422, 429, 502].map((s) => new GitHubWorkerDispatchError(s, "GH_WORKER_REPO secret"))];
  for (const error of errors) {
    const { message, action } = classifyRenderFailure(error, "0a1b2c3d");
    const stored = encodeStoredFailure(message, action);
    assert.equal(renderFailureMessage(stored), message);
    const html = videoPage({ ...failed, error_message: stored }, { message, outcome: { retry: action === "support" ? "support" : "available", charge: "unknown", status: "failed", attempts: 1 } });
    const text = html.replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(text, INTERNAL, message);
    assert.doesNotMatch(text, /\[\[action:/);
  }
});

test("route contract: zero charge only after the queued CAS and a confirmed release; action typed from the classifier", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", "app", "api", "generate", "[id]", "render", "route.ts"), "utf-8");
  const failPath = source.slice(source.indexOf("await worker.trigger("));
  assert.match(failPath, /const \{ message, action \} = classifyRenderFailure\(error, diagnosticId\)/);
  assert.match(failPath, /retry: action === "support" \? "support" : "available", charge: "unknown"/);
  assert.match(failPath, /error_message: encodeStoredFailure\(message, action\)/);
  assert.match(failPath, /failed\?\.length === 1\)[\s\S]*releaseUnusedJobSupply[\s\S]*if \(released\) outcome\.charge = "none_proven"/);
  assert.match(failPath, /NextResponse\.json\(\{ error: message, outcome \}/);
  assert.doesNotMatch(source, /requiresSupport|Contacta al soporte/, "the route never decides from wording");
});
