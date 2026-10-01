import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleReviewRequest, type ReviewRouteDeps, type ReviewUser } from "./review-route";

// RC-002 AUTHENTICATED_REVIEW_DELIVERY_FALSE_PASS: MODULE_PASS + UNAUTH_REDIRECT_PASS != DELIVERY_PASS.
// These tests drive the whole authenticated path of /r/<slug> with fake dependencies (no real
// credentials, cookies or tokens): session -> owner gate -> allowlist -> private object -> bytes.

const AUDIO = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
const OWNER = "owner@example.test";
const SLUG = "video-004-pron-gate";
const EXPECTED_UPSTREAM = "https://proj.supabase.co/storage/v1/object/authenticated/videos/video-004-thermopylae/v3/pron-gate/pron-gate-review.mp3";

function fakeStorage(): ReviewRouteDeps["fetch"] {
  return async (url, init) => {
    assert.equal(url, EXPECTED_UPSTREAM);
    assert.equal(init.headers.Authorization, "Bearer service-key");
    const range = init.headers.Range;
    if (!range) return new Response(AUDIO, { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(AUDIO.length), "accept-ranges": "bytes" } });
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)!;
    const start = Number(m[1] || 0), end = m[2] ? Math.min(Number(m[2]), AUDIO.length - 1) : AUDIO.length - 1;
    const part = AUDIO.subarray(start, end + 1);
    return new Response(part, { status: 206, headers: { "content-type": "audio/mpeg", "content-length": String(part.length), "content-range": `bytes ${start}-${end}/${AUDIO.length}` } });
  };
}

function deps(user: ReviewUser, overrides: Partial<ReviewRouteDeps> = {}): ReviewRouteDeps {
  return {
    getUser: async () => user,
    isOwner: (u) => Boolean(u.email_confirmed_at && u.email?.toLowerCase() === OWNER),
    gateConfigured: () => true,
    fetch: fakeStorage(),
    supabaseUrl: () => "https://proj.supabase.co",
    serviceKey: () => "service-key",
    ...overrides,
  };
}

const owner: ReviewUser = { email: OWNER, email_confirmed_at: "2026-09-08T17:30:12Z" };
const req = (headers: Record<string, string> = {}) => new Request(`https://atomivid.example/r/${SLUG}`, { headers });
const sha = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");

test("AUTHENTICATED_OWNER_GET_DELIVERS_AUDIO_BYTES (200, audio/mpeg, exact bytes)", async () => {
  const res = await handleReviewRequest(req(), SLUG, deps(owner));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, AUDIO.length);
  assert.equal(sha(body), sha(AUDIO));
  assert.equal(res.headers.get("x-review-denied"), null);
});

test("AUTHENTICATED_OWNER_RANGE_DELIVERS_206 (Range: bytes=0-999 -> 206 with Content-Range)", async () => {
  const res = await handleReviewRequest(req({ Range: "bytes=0-999" }), SLUG, deps(owner));
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.equal(res.headers.get("content-range"), `bytes 0-999/${AUDIO.length}`);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 1000);
  assert.equal(sha(body), sha(AUDIO.subarray(0, 1000)));
});

test("anonymous request -> 307 to /login with redirectedFrom", async () => {
  const res = await handleReviewRequest(req(), SLUG, deps(null));
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("location"), `https://atomivid.example/login?redirectedFrom=%2Fr%2F${SLUG}`);
});

test("unknown slug -> 404 before any session or storage access", async () => {
  let touched = false;
  const res = await handleReviewRequest(new Request("https://atomivid.example/r/nope"), "nope", deps(owner, { getUser: async () => { touched = true; return owner; }, fetch: async () => { touched = true; throw new Error("must not fetch"); } }));
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("x-review-denied"), "unknown-slug");
  assert.equal(touched, false);
});

test("signed-in non-owner -> 403, nothing fetched, reason is diagnosable without leaking the owner", async () => {
  let fetched = false;
  const other: ReviewUser = { email: "someone@example.test", email_confirmed_at: "2026-09-16T14:49:11Z" };
  const res = await handleReviewRequest(req(), SLUG, deps(other, { fetch: async () => { fetched = true; throw new Error("must not fetch"); } }));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-review-denied"), "not-owner");
  assert.equal(fetched, false);
  assert.ok(!(await res.text()).includes(OWNER));
});

test("RC-002: owner gate without configuration denies the real owner and says so", async () => {
  const res = await handleReviewRequest(req(), SLUG, deps(owner, { isOwner: () => false, gateConfigured: () => false }));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-review-denied"), "owner-gate-unconfigured");
  assert.equal(res.headers.get("x-review-gate"), "unconfigured");
});

test("unconfirmed e-mail is denied with its own reason", async () => {
  const res = await handleReviewRequest(req(), SLUG, deps({ email: OWNER }));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-review-denied"), "email-unconfirmed");
});

test("upstream failure never leaks the storage response", async () => {
  const res = await handleReviewRequest(req(), SLUG, deps(owner, { fetch: async () => new Response('{"error":"secret details"}', { status: 400 }) }));
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "review object unavailable");
});
