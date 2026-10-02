/**
 * PI V2 Fase B3.3 (RB-06): /r/<slug> admits only the Review Delivery owner (isReviewOwner,
 * REVIEW_DELIVERY_OWNER_USER_ID), and nobody receives a signed URL of the asset.
 * Fake dependencies only: no network, no credentials, no Supabase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { handleReviewRequest, type ReviewRouteDeps, type ReviewUser } from "./review-route";
import { isReviewOwner, reviewOwnerUserId } from "./review-stream";

const OWNER_ID = "0wner000-0000-4000-8000-000000000001";
const OTHER_ID = "07her000-0000-4000-8000-000000000002";
const AVATAR_ALLOWLIST_EMAIL = "avatar-allowlist@test.local";
const ENV = { REVIEW_DELIVERY_OWNER_USER_ID: OWNER_ID, AVATAR_PREPARATION_OWNER_EMAIL: AVATAR_ALLOWLIST_EMAIL };
const SERVICE_KEY = "service-role-key-never-leaves-the-server";
const AUDIO = Buffer.from("ID3-fake-review-bytes");
const SLUG = "video-004-pron-gate";

const owner: ReviewUser = { id: OWNER_ID, email: "owner@test.local", email_confirmed_at: "2026-09-08T00:00:00Z" };
// A signed-in, confirmed user who is NOT the review owner but IS on the old avatar e-mail allowlist.
const other: ReviewUser = { id: OTHER_ID, email: AVATAR_ALLOWLIST_EMAIL, email_confirmed_at: "2026-09-08T00:00:00Z" };

function deps(user: ReviewUser, env: Record<string, string | undefined> = ENV) {
  const fetched: Array<{ url: string; headers: Record<string, string> }> = [];
  const d: ReviewRouteDeps = {
    getUser: async () => user,
    isOwner: (u) => isReviewOwner(u, env),
    gateConfigured: () => reviewOwnerUserId(env) !== null,
    fetch: async (url, init) => {
      fetched.push({ url, headers: init.headers });
      return new Response(AUDIO, { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(AUDIO.byteLength) } });
    },
    supabaseUrl: () => "https://proj.supabase.co",
    serviceKey: () => SERVICE_KEY,
  };
  return { d, fetched };
}

const req = () => new Request(`https://atomivid.vercel.app/r/${SLUG}`);
const SIGNED = /token=|\/object\/sign\/|X-Amz-Signature|Signature=/i;

async function exposed(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  const body = res.body ? Buffer.from(await res.arrayBuffer()).toString("latin1") : "";
  return `${headers}\n${body}`;
}

test("B3.3-1: the review owner gets the bytes, streamed by the server from the private object", async () => {
  const { d, fetched } = deps(owner);
  const res = await handleReviewRequest(req(), SLUG, d);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), AUDIO);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0].url, /\/storage\/v1\/object\/authenticated\/videos\//, "authenticated object endpoint, not a signed URL");
});

test("B3.3-2: another signed-in user is refused even when on the avatar e-mail allowlist; no object read", async () => {
  const { d, fetched } = deps(other);
  const res = await handleReviewRequest(req(), SLUG, d);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-review-denied"), "not-owner");
  assert.equal(fetched.length, 0);
});

test("B3.3-3: anonymous is redirected to login; no object read", async () => {
  const { d, fetched } = deps(null);
  const res = await handleReviewRequest(req(), SLUG, d);
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
  assert.equal(fetched.length, 0);
});

test("B3.3-4: none of owner, other or anonymous receives a signed URL or the service key", async () => {
  for (const user of [owner, other, null]) {
    const { d } = deps(user);
    const text = await exposed(await handleReviewRequest(req(), SLUG, d));
    assert.ok(!SIGNED.test(text), `signed URL exposed to ${user?.id ?? "anonymous"}`);
    assert.ok(!text.includes(SERVICE_KEY), `service key exposed to ${user?.id ?? "anonymous"}`);
  }
});

test("B3.3-5: fail closed — unconfigured owner id or unconfirmed e-mail denies even the owner; unknown slug never reads the session", async () => {
  const unconfigured = deps(owner, { AVATAR_PREPARATION_OWNER_EMAIL: AVATAR_ALLOWLIST_EMAIL });
  const r1 = await handleReviewRequest(req(), SLUG, unconfigured.d);
  assert.deepEqual([r1.status, r1.headers.get("x-review-denied"), unconfigured.fetched.length], [403, "owner-gate-unconfigured", 0]);
  const unconfirmed = deps({ ...owner!, email_confirmed_at: undefined });
  const r2 = await handleReviewRequest(req(), SLUG, unconfirmed.d);
  assert.deepEqual([r2.status, r2.headers.get("x-review-denied"), unconfirmed.fetched.length], [403, "email-unconfirmed", 0]);
  let sessionRead = false;
  const unknown = deps(owner);
  const r3 = await handleReviewRequest(new Request("https://atomivid.vercel.app/r/nope-slug"), "nope-slug", { ...unknown.d, getUser: async () => { sessionRead = true; return owner; } });
  assert.deepEqual([r3.status, sessionRead, unknown.fetched.length], [404, false, 0]);
});

test("B3.3-6: the Next route wires isReviewOwner through handleReviewRequest, not the avatar e-mail allowlist", () => {
  const src = readFileSync(path.join(__dirname, "../../app/r/[slug]/route.ts"), "utf8");
  assert.match(src, /handleReviewRequest\(/);
  assert.match(src, /isOwner: \(user[^)]*\) => isReviewOwner\(user\)/);
  assert.ok(!/canPrepareAvatar/.test(src), "the review route must not use the avatar preparation allowlist");
});
