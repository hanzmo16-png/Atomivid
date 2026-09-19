import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadablePath } from "./download";
const row = { id: "request-a", user_id: "owner-a", status: "completed", video_path: "request-a/attempt-1/final.mp4" };
test("download accepts completed normal/avatar output owned by requester", () => {
  assert.equal(downloadablePath(row, "owner-a", "request-a"), row.video_path);
});
test("download cannot sign another owner's media even if the query returned it", () => {
  assert.equal(downloadablePath(row, "owner-b", "request-a"), null);
  assert.equal(downloadablePath(row, "", "request-a"), null);
  assert.equal(downloadablePath(null, "owner-a", "request-a"), null);
});
test("download denies incomplete jobs and mismatched request IDs", () => {
  for (const status of ["pending", "script_ready", "processing", "failed"]) {
    assert.equal(downloadablePath({ ...row, status }, "owner-a", "request-a"), null);
  }
  assert.equal(downloadablePath(row, "owner-a", "request-b"), null);
  assert.equal(downloadablePath({ ...row, video_path: null }, "owner-a", "request-a"), null);
});
