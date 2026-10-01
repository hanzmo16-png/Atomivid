/**
 * App-controlled review delivery (incident REVIEW_DELIVERY_ANDROID_INVALID_JWT, 2026-10-01).
 *
 * A long Supabase signed URL (a ~470-char JWT in the query string) verified from a GitHub runner
 * (GET 200, Range 206, right content-type) failed on the user's Samsung/Android/Chrome with
 * 400 InvalidJWT "signature verification failed" — twice (review MP4, then the pronunciation-gate MP3).
 * RUNNER_HTTP_200 is therefore NOT a delivery pass. This module backs a short URL served by the app
 * (/r/<slug>) that authenticates the owner server-side, fetches the private object with the service
 * key (never sent to the client), forwards Range and streams it back with the right Content-Type.
 * The bucket stays private, no JWT reaches the phone, nothing here logs URLs or tokens.
 */

export type ReviewObject = { bucket: string; path: string; contentType: string; filename: string; what: string };

/** Static allowlist: only objects named here are reachable through /r/<slug>. No DB, no migration. */
export const REVIEW_OBJECTS: Record<string, ReviewObject> = {
  "video-004-pron-gate": {
    bucket: "videos",
    path: "video-004-thermopylae/v3/pron-gate/pron-gate-review.mp3",
    contentType: "audio/mpeg",
    filename: "VIDEO-004-pron-gate-review.mp3",
    what: "Thermopylae V3 pronunciation gate G1+G2+G3 review audio",
  },
  "video-004-v3-review": {
    bucket: "videos",
    path: "video-004-thermopylae/review/VIDEO-004-Three-Days-at-the-Hot-Gates-v3-review-480p.mp4",
    contentType: "video/mp4",
    filename: "VIDEO-004-v3-review-480p.mp4",
    what: "Thermopylae V3 480p review proxy (final polish)",
  },
  "video-004-v2-review": {
    bucket: "videos",
    path: "video-004-thermopylae/review/VIDEO-004-Three-Days-at-the-Hot-Gates-v2-review-480p.mp4",
    contentType: "video/mp4",
    filename: "VIDEO-004-v2-review-480p.mp4",
    what: "Thermopylae V2 480p review proxy",
  },
  "video-004-v1-review": {
    bucket: "videos",
    path: "video-004-thermopylae/review/VIDEO-004-Three-Days-at-the-Hot-Gates-review-480p.mp4",
    contentType: "video/mp4",
    filename: "VIDEO-004-v1-review-480p.mp4",
    what: "Thermopylae V1 480p review proxy",
  },
};

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function resolveReviewObject(slug: string): ReviewObject | null {
  if (!SLUG.test(slug)) return null;
  return Object.prototype.hasOwnProperty.call(REVIEW_OBJECTS, slug) ? REVIEW_OBJECTS[slug] : null;
}

/** Only a syntactically valid single byte range is forwarded; anything else gets the whole object. */
export function forwardableRange(range: string | null | undefined): string | null {
  if (!range) return null;
  return /^bytes=\d*-\d*$/.test(range.trim()) && range.trim() !== "bytes=-" ? range.trim() : null;
}

/** Upstream request: private object endpoint + service key. The key never leaves the server. */
export function upstreamRequest(supabaseUrl: string, serviceKey: string, obj: ReviewObject, range: string | null): { url: string; headers: Record<string, string> } {
  const base = supabaseUrl.replace(/\/+$/, "");
  const path = obj.path.split("/").map(encodeURIComponent).join("/");
  const headers: Record<string, string> = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
  if (range) headers.Range = range;
  return { url: `${base}/storage/v1/object/authenticated/${obj.bucket}/${path}`, headers };
}

/** Headers the phone receives: forced content-type, byte-range metadata, never cached, never indexed. */
export function responseHeaders(upstream: { get(name: string): string | null }, obj: ReviewObject): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": obj.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex",
    "Content-Disposition": `inline; filename="${obj.filename}"`,
  };
  for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
    const v = upstream.get(name);
    if (v) h[name.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase())] = v;
  }
  return h;
}

/** Upstream statuses passed through unchanged; everything else becomes a 502 without leaking the body. */
export function passthroughStatus(status: number): number {
  return status === 200 || status === 206 || status === 416 ? status : 502;
}

/** Strips any signed-URL token before a string may reach a log line. */
export function redactSignedUrl(s: string): string {
  return s.replace(/([?&]token=)[A-Za-z0-9._-]+/g, "$1<redacted>");
}

// ---- Delivery QA classification (PI V2 Reality Check RB-05 / RB-06) ----

export type DeliveryChannel = "long_signed_url" | "app_short_url";
export type RunnerCheck = { get: number; range: number; contentType: string | null };
export type DeviceCheck = { confirmedOnDevice: boolean; device?: string } | null;
export type DeliveryVerdict = "RUNNER_PASS" | "DELIVERY_PASS" | "DELIVERY_FAIL";

/**
 * A runner-side HTTP 200/206 proves the object and the signature are good FROM THE RUNNER. It does not
 * prove the user's phone can open the link. Delivery passes only with confirmation from the device,
 * whatever the channel. A long signed URL that only has a runner pass stays RUNNER_PASS.
 */
export function classifyReviewDelivery(input: { channel: DeliveryChannel; runner: RunnerCheck; device: DeviceCheck; expectedContentType: string }): DeliveryVerdict {
  const runnerOk = input.runner.get === 200 && input.runner.range === 206 && (input.runner.contentType ?? "").toLowerCase().startsWith(input.expectedContentType.toLowerCase());
  if (!runnerOk) return "DELIVERY_FAIL";
  if (input.device?.confirmedOnDevice) return "DELIVERY_PASS";
  if (input.device && !input.device.confirmedOnDevice) return "DELIVERY_FAIL";
  return "RUNNER_PASS";
}
