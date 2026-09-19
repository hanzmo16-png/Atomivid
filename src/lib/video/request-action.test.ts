import { test } from "node:test";
import assert from "node:assert/strict";
import { requestAction } from "./request-action";
import type { VideoRequestSummary } from "./request-view";
const now = Date.parse("2026-01-01T12:00:00Z");
const row: VideoRequestSummary = { id: "example", mode: "visual", topic: "Example", style: "Example", duration_seconds: 30, language: "es", status: "script_ready", video_path: null, error_message: null, script_json: {}, progress_stage: null, render_attempts: 1, render_started_at: null, created_at: new Date(now).toISOString() };
test("avatar failures never offer a paid retry, even without a script", () => {
  for (const script_json of [null, {}]) assert.equal(requestAction({ ...row, mode: "avatar", status: "failed", script_json }, now), "private-review");
  assert.equal(requestAction({ ...row, mode: "avatar", status: "processing", render_started_at: "2025-01-01T00:00:00Z" }, now), "private-review");
});
test("active and completed jobs never offer generation", () => {
  for (const mode of ["avatar", "visual"]) for (const status of ["processing", "completed"]) assert.equal(requestAction({ ...row, mode, status, render_started_at: new Date(now).toISOString() }, now), null);
});
test("both modes use review; normal jobs honor limits and credential failures", () => {
  for (const mode of ["avatar", "visual"]) assert.equal(requestAction({ ...row, mode }, now), "review");
  assert.equal(requestAction({ ...row, status: "failed", render_attempts: 3 }, now), "limit");
  assert.equal(requestAction({ ...row, status: "failed", error_message: "provider HTTP 403" }, now), "access-review");
  assert.equal(requestAction({ ...row, status: "failed", error_message: "timeout" }, now), "retry");
});
