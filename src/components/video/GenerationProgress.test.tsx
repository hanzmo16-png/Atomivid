import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { GenerationProgress } from "@/components/ui/GenerationProgress";
import { RequestCard } from "./RequestCard";
import { ResultView } from "./ResultView";
import { ReelProgressBar } from "./ReelProgressBar";
import { VfxProgress } from "@/app/dashboard/vfx/VfxProgress";
import type { VideoRequestSummary } from "@/lib/video/request-view";
import type { Job } from "@/lib/production-intelligence/vfx-director/jobs";
import { LONG_FORM_HEARTBEAT_STALE_MS, MAX_RENDER_ATTEMPTS, RENDER_TIMEOUT_MS } from "@/lib/video/limits";

const now = Date.parse("2026-10-04T12:30:00Z");
const request: VideoRequestSummary = {
  id: "avatar", mode: "avatar", topic: "Mi avatar", style: "Educativo", duration_seconds: 30,
  language: "es", status: "processing", video_path: null, error_message: null, script_json: {},
  progress_stage: "render", render_attempts: 1, render_started_at: new Date(now - 60_000).toISOString(),
  created_at: new Date(now - 120_000).toISOString(),
};
const value = (html: string) => Number(html.match(/aria-valuenow="(\d+)"/)?.[1]);

test("avatar uses its own pipeline, consistently in history and details", () => {
  for (const component of [<RequestCard key="history" request={request} nowMs={now} />, <ResultView key="detail" request={request} nowMs={now} />]) {
    const html = renderToStaticMarkup(component);
    assert.equal(value(html), 50);
    assert.match(html, /2 de 4 etapas completadas/);
  }
  assert.deepEqual(["queued", "voice", "render", "uploading"].map(stage => value(renderToStaticMarkup(<ReelProgressBar avatar stage={stage} />))), [0, 25, 50, 75]);
  assert.doesNotMatch(renderToStaticMarkup(<ReelProgressBar avatar stage="footage" />), /aria-valuenow/);
});

test("long form keeps unit-based progress identical on both surfaces", () => {
  const lf = { ...request, mode: "long_form", long_form_stage: "assets", long_form_progress: { stage: "assets", unitsCompleted: 5, unitsTotal: 10, unitLabel: "recursos", updatedAt: new Date(now).toISOString() } };
  for (const component of [<RequestCard key="history" request={lf} nowMs={now} />, <ResultView key="detail" request={lf} nowMs={now} />]) {
    assert.equal(value(renderToStaticMarkup(component)), 43);
  }
  const queued = { ...lf, long_form_stage: "queued", long_form_progress: null };
  for (const component of [<RequestCard key="history" request={queued} nowMs={now} />, <ResultView key="detail" request={queued} nowMs={now} />]) {
    const html = renderToStaticMarkup(component);
    assert.match(html, /role="progressbar"/);
    assert.doesNotMatch(html, /aria-valuenow/);
  }
});

test("terminal requests remove bars for every video mode", () => {
  for (const mode of ["avatar", "visual", "long_form"]) for (const status of ["failed", "completed"]) {
    const terminal = { ...request, mode, status, render_attempts: MAX_RENDER_ATTEMPTS };
    assert.doesNotMatch(renderToStaticMarkup(<RequestCard request={terminal} nowMs={now} />), /role="progressbar"/);
    assert.doesNotMatch(renderToStaticMarkup(<ResultView request={terminal} nowMs={now} />), /role="progressbar"/);
  }
});

test("stalled requests stop claiming active progress in history and details without starting another job", () => {
  for (const mode of ["avatar", "visual", "long_form"]) {
    const timeout = mode === "long_form" ? LONG_FORM_HEARTBEAT_STALE_MS : RENDER_TIMEOUT_MS;
    const stale = { ...request, mode, render_attempts: MAX_RENDER_ATTEMPTS,
      render_started_at: new Date(now - timeout - 1).toISOString(),
      long_form_stage: "assets", long_form_progress: { stage: "assets", unitsCompleted: 5,
        unitsTotal: 10, unitLabel: "recursos", updatedAt: new Date(now - timeout - 1).toISOString() } };
    for (const html of [renderToStaticMarkup(<RequestCard request={stale} nowMs={now} />),
      renderToStaticMarkup(<ResultView request={stale} nowMs={now} />)]) {
      assert.match(html, /Esto está tardando más de lo normal/);
      assert.doesNotMatch(html, /role="progressbar"/);
      assert.doesNotMatch(html, /Reintentar/);
    }
    const detail = renderToStaticMarkup(<ResultView request={stale} nowMs={now} />);
    assert.match(detail, /Tu solicitud sigue guardada/);
    assert.match(detail, /Volver al historial/);
  }
});

test("a long-form job with a recent heartbeat keeps measured progress despite an old start", () => {
  const live = { ...request, mode: "long_form", render_started_at: new Date(now - RENDER_TIMEOUT_MS * 3).toISOString(),
    long_form_stage: "assets", long_form_progress: { stage: "assets", unitsCompleted: 5,
      unitsTotal: 10, unitLabel: "recursos", updatedAt: new Date(now).toISOString() } };
  const html = renderToStaticMarkup(<ResultView request={live} nowMs={now} />);
  assert.equal(value(html), 43);
  assert.doesNotMatch(html, /Esto está tardando más de lo normal/);
});

test("unknown or nonfinite measurements show activity without a false percentage", () => {
  for (const percent of [null, NaN, Infinity]) {
    const html = renderToStaticMarkup(<GenerationProgress label="Generando guion" percent={percent} />);
    assert.match(html, /role="progressbar"/);
    assert.match(html, /motion-reduce:animate-none/);
    assert.doesNotMatch(html, /aria-valuenow|NaN|Infinity|\d+%/);
  }
});

test("VFX counts current plan results, ignoring old outputs and reporting a stop", () => {
  const plan = { tasks: [{ id: "one" }, { id: "two" }, { id: "three" }] } as Job["plan"];
  const results = { one: { assetId: "a", sha256: "hash", checks: [] }, obsolete: { assetId: "old", sha256: "hash", checks: [] } };
  const html = renderToStaticMarkup(<VfxProgress job={{ plan, results, status: "FAILED" }} />);
  assert.equal(value(html), 33);
  assert.match(html, /1 de 3 tareas/);
  assert.match(html, /Ejecución detenida/);
});
