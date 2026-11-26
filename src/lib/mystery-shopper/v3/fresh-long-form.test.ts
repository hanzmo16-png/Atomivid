import test from "node:test";
import assert from "node:assert/strict";
import { freshLongFormPreflight, freshRequestId } from "../../../../scripts/mystery-shopper/fresh-long-form";

test("fresh journey rejects every reuse control and a total budget above two dollars", () => {
  for (const key of ["MS_YOUTUBE_RESUME_REQUEST_ID", "MS_YOUTUBE_EXISTING_SCRIPT_KEY", "MS_YOUTUBE_EXISTING_RENDER_KEY", "MS_YOUTUBE_ALREADY_CONFIRMED", "MS_YOUTUBE_RESUME_RETRY"])
    assert.ok(freshLongFormPreflight({ MS_YOUTUBE_FRESH: "1", [key]: "1" }, 3, 2));
  for (const cap of [0, -1, NaN, Infinity, 2.01]) assert.ok(freshLongFormPreflight({ MS_YOUTUBE_FRESH: "1" }, 3, cap));
  assert.ok(freshLongFormPreflight({ MS_YOUTUBE_FRESH: "1" }, 2, 2));
  assert.equal(freshLongFormPreflight({ MS_YOUTUBE_FRESH: "1" }, 3, 2), null);
  assert.equal(freshLongFormPreflight({}, 3, 2), null);
});

test("fresh identity accepts only one canonical configure request", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  assert.equal(freshRequestId(`/dashboard/long-form/configure/${id}`), id);
  for (const input of ["", `/dashboard/videos/${id}`, `/dashboard/long-form/configure/${id}?existing=1`, `/dashboard/long-form/configure/${id}/other`]) assert.equal(freshRequestId(input), null);
});
