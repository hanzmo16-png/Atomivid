import test from "node:test";
import assert from "node:assert/strict";
import { classifyReviewDelivery, forwardableRange, passthroughStatus, redactSignedUrl, resolveReviewObject, responseHeaders, upstreamRequest } from "./review-stream";

// Incident REVIEW_DELIVERY_ANDROID_INVALID_JWT (2026-10-01): a long signed URL answered 200/206/audio
// from a GitHub runner and 400 InvalidJWT on the user's Samsung/Android/Chrome. Twice.
test("LONG_SIGNED_URL_RUNNER_PASS_IS_NOT_SUFFICIENT_FOR_DELIVERY_PASS", () => {
  const runner = { get: 200, range: 206, contentType: "audio/mpeg" };
  assert.equal(classifyReviewDelivery({ channel: "long_signed_url", runner, device: null, expectedContentType: "audio/mpeg" }), "RUNNER_PASS");
  assert.notEqual(classifyReviewDelivery({ channel: "long_signed_url", runner, device: null, expectedContentType: "audio/mpeg" }), "DELIVERY_PASS");
  // the real incident: runner pass + device failure => DELIVERY_FAIL, never a pass
  assert.equal(classifyReviewDelivery({ channel: "long_signed_url", runner, device: { confirmedOnDevice: false, device: "Samsung/Android/Chrome" }, expectedContentType: "audio/mpeg" }), "DELIVERY_FAIL");
  // only the device confirms delivery, on any channel
  assert.equal(classifyReviewDelivery({ channel: "app_short_url", runner, device: { confirmedOnDevice: true, device: "Samsung/Android/Chrome" }, expectedContentType: "audio/mpeg" }), "DELIVERY_PASS");
  assert.equal(classifyReviewDelivery({ channel: "app_short_url", runner, device: null, expectedContentType: "audio/mpeg" }), "RUNNER_PASS");
  // a runner failure is a failure regardless of channel
  assert.equal(classifyReviewDelivery({ channel: "app_short_url", runner: { get: 200, range: 200, contentType: "audio/mpeg" }, device: { confirmedOnDevice: true }, expectedContentType: "audio/mpeg" }), "DELIVERY_FAIL");
  assert.equal(classifyReviewDelivery({ channel: "app_short_url", runner: { get: 200, range: 206, contentType: "application/json" }, device: null, expectedContentType: "audio/mpeg" }), "DELIVERY_FAIL");
});

test("short review route resolves only allowlisted slugs", () => {
  assert.equal(resolveReviewObject("video-004-pron-gate")?.contentType, "audio/mpeg");
  assert.equal(resolveReviewObject("video-004-v2-review")?.contentType, "video/mp4");
  assert.equal(resolveReviewObject("../../etc"), null);
  assert.equal(resolveReviewObject("constructor"), null);
  assert.equal(resolveReviewObject("VIDEO-004-PRON-GATE"), null);
  assert.equal(resolveReviewObject(""), null);
});

test("upstream request uses the private object endpoint with the service key and forwards a valid Range only", () => {
  const obj = resolveReviewObject("video-004-pron-gate")!;
  const r = upstreamRequest("https://proj.supabase.co/", "service-key", obj, forwardableRange("bytes=0-"));
  assert.equal(r.url, "https://proj.supabase.co/storage/v1/object/authenticated/videos/video-004-thermopylae/v3/pron-gate/pron-gate-review.mp3");
  assert.equal(r.headers.Authorization, "Bearer service-key");
  assert.equal(r.headers.apikey, "service-key");
  assert.equal(r.headers.Range, "bytes=0-");
  assert.ok(!r.url.includes("token="), "no signed URL token anywhere in the upstream request");
  assert.equal(forwardableRange("bytes=1000-1999"), "bytes=1000-1999");
  assert.equal(forwardableRange("bytes=0-99, 200-299"), null);
  assert.equal(forwardableRange("items=0-1"), null);
  assert.equal(forwardableRange(null), null);
});

test("client response: forced content-type, Range metadata passed through, never cached, nothing else leaks", () => {
  const obj = resolveReviewObject("video-004-pron-gate")!;
  const upstream = new Headers({ "content-type": "application/octet-stream", "content-length": "1000", "content-range": "bytes 0-999/536703", "x-sb-internal": "secret", "set-cookie": "a=b" });
  const h = responseHeaders(upstream, obj);
  assert.equal(h["Content-Type"], "audio/mpeg");
  assert.equal(h["Accept-Ranges"], "bytes");
  assert.equal(h["Content-Length"], "1000");
  assert.equal(h["Content-Range"], "bytes 0-999/536703");
  assert.equal(h["Cache-Control"], "private, no-store");
  assert.equal(Object.keys(h).some((k) => /x-sb|cookie/i.test(k)), false);
  assert.equal(passthroughStatus(200), 200);
  assert.equal(passthroughStatus(206), 206);
  assert.equal(passthroughStatus(400), 502);
  assert.equal(passthroughStatus(404), 502);
});

test("signed URL tokens never survive into a log line", () => {
  const s = "https://proj.supabase.co/storage/v1/object/sign/videos/a.mp3?token=eyJhbGciOiJIUzUxMiJ9.eyJ1cmwiOiJ4In0.abc-DEF_123";
  assert.equal(redactSignedUrl(s), "https://proj.supabase.co/storage/v1/object/sign/videos/a.mp3?token=<redacted>");
});
