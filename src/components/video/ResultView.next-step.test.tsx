import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ResultView } from "./ResultView";
import type { VideoRequestSummary } from "@/lib/video/request-view";

const base = { id: "22222222-2222-4222-8222-222222222222", topic: "Gucci", style: "Documental", duration_seconds: 420, language: "en", status: "script_ready",
  video_path: null, error_message: null, script_json: null, progress_stage: null, render_attempts: 0, render_started_at: null, created_at: new Date(0).toISOString(),
  aspect_ratio: "16:9", long_form_stage: null, long_form_progress: null } as unknown as VideoRequestSummary;
// GenerateButton needs a mounted app router; nothing is clicked in these tests.
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;
const render = (r: Partial<VideoRequestSummary>) => renderToStaticMarkup(<AppRouterContext.Provider value={router}><ResultView request={{ ...base, ...r }} nowMs={0} /></AppRouterContext.Provider>);

/** Regression: the detail page of a script_ready long-form request showed only
 * "Todavía no se generó el video" with no way to continue. */
test("script_ready long-form request offers the configure step on its detail page", () => {
  const html = render({ mode: "long_form", long_form_confirmed_at: null });
  assert.ok(html.includes(`href="/dashboard/long-form/configure/${base.id}"`));
  assert.ok(html.includes("Revisar y configurar producción"));
  assert.ok(existsSync("src/app/dashboard/long-form/configure/[id]/page.tsx"));
  assert.ok(!html.includes("Iniciar producción"), "unconfirmed: navigation only, never a start button");
});
test("confirmed long-form, short scripts and other states keep their own behaviour", () => {
  const confirmed = render({ mode: "long_form", long_form_confirmed_at: "2026-10-07T00:00:00Z" });
  assert.ok(!confirmed.includes("configure"), "a confirmed plan is not reconfigured (the configure page redirects here)");
  assert.ok(confirmed.includes("Iniciar producción"), "confirmed plan: explicit start, same as the history card");
  assert.ok(render({ mode: "faceless" }).includes(`href="/dashboard/review/${base.id}"`));
  for (const status of ["pending", "processing", "failed"]) assert.ok(!render({ mode: "long_form", status }).includes("Revisar y configurar producción"));
});
