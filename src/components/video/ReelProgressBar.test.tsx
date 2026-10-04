import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ReelProgressBar } from "./ReelProgressBar";
import { RequestCard } from "./RequestCard";
import { ResultView } from "./ResultView";
import type { VideoRequestSummary } from "@/lib/video/request-view";

const now = Date.parse("2026-10-04T12:30:00Z");
const request: VideoRequestSummary = {
  id: "reel", mode: "visual", topic: "Tres decisiones", style: "Educativo", duration_seconds: 30,
  language: "es", status: "processing", video_path: null, error_message: null, script_json: {},
  progress_stage: "render", render_attempts: 1, render_started_at: new Date(now - 60_000).toISOString(),
  created_at: new Date(now - 120_000).toISOString(),
};

test("an in-flight reel shows the same stage percentage in history and detail", () => {
  for (const component of [<RequestCard key="history" request={request} nowMs={now} />, <ResultView key="detail" request={request} nowMs={now} />]) {
    const html = renderToStaticMarkup(component);
    assert.match(html, /role="progressbar"/);
    assert.match(html, /aria-valuenow="67"/);
    assert.match(html, /4 de 6 etapas completadas/);
    assert.match(html, /width:67%/);
    assert.match(html, /Ensamblando el video/);
  }
});

test("stage updates advance the bar; upload never claims completion", () => {
  const values = ["queued", "voice", "footage", "music", "render", "uploading"].map(stage => {
    const html = renderToStaticMarkup(<ReelProgressBar stage={stage} />);
    return Number(html.match(/aria-valuenow="(\d+)"/)?.[1]);
  });
  assert.deepEqual(values, [0, 17, 33, 50, 67, 83]);
});

test("unknown stages have no numeric claim and completed requests remove the progress bar", () => {
  for (const stage of [null, "future-stage"]) {
    const html = renderToStaticMarkup(<ReelProgressBar stage={stage} />);
    assert.match(html, /role="progressbar"/);
    assert.doesNotMatch(html, /aria-valuenow|\d+%/);
  }
  for (const component of [
    <RequestCard key="history" request={{ ...request, status: "completed" }} nowMs={now} />,
    <ResultView key="detail" request={{ ...request, status: "completed" }} nowMs={now} />,
    <RequestCard key="avatar" request={{ ...request, mode: "avatar" }} nowMs={now} />,
  ]) assert.doesNotMatch(renderToStaticMarkup(component), /role="progressbar"/);
});
