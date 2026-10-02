/**
 * PI V2 Fase B3 — RB-06 tenant isolation at the signing site (docs/audits/PI-V2-REALITY-CHECK.md,
 * RB-06: `src/lib/storage/signed-url.ts:13-23`, `src/app/dashboard/videos/[id]/page.tsx:67-68`,
 * `src/app/dashboard/page.tsx:52-58`). Written first, against the current code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getSignedVideoUrlForRequest, ownedVideoPath } from "./signed-url";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const reqA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const reqB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function signSpy() {
  const calls: string[] = [];
  const sign = async (p: string) => { calls.push(p); return `https://proj.supabase.co/storage/v1/object/sign/videos/${p}?token=SECRET`; };
  return { sign, calls };
}

test("B3-1: user A cannot obtain a signed URL for user B's video_path — denied, zero signed URL, zero service-role signing for that path", async () => {
  const { sign, calls } = signSpy();
  // (a) A's own row points at B's object (forged video_path on a row A owns).
  const forged = { id: reqA, user_id: A, video_path: `${reqB}/output/final.mp4` };
  assert.equal(await getSignedVideoUrlForRequest(forged, A, sign), null);
  // (b) B's row itself (lookup bug or forged user_id).
  const foreign = { id: reqB, user_id: B, video_path: `${reqB}/output/final.mp4` };
  assert.equal(await getSignedVideoUrlForRequest(foreign, A, sign), null);
  // (c) An owner-only review object with a fixed path (review-stream allowlist) through a forged row.
  const review = { id: reqA, user_id: A, video_path: "video-004-thermopylae/review/VIDEO-004-Three-Days-at-the-Hot-Gates-v3-review-480p.mp4" };
  assert.equal(await getSignedVideoUrlForRequest(review, A, sign), null);
  // (d) Path traversal / prefix tricks.
  for (const p of [`${reqA}/../${reqB}/output/final.mp4`, `${reqA}x/output/final.mp4`, `/${reqA}/output/final.mp4`, ""]) {
    assert.equal(await getSignedVideoUrlForRequest({ id: reqA, user_id: A, video_path: p }, A, sign), null, p);
  }
  assert.deepEqual(calls, [], "the service role never signed any of those paths");

  // A signs A's own object.
  const own = { id: reqA, user_id: A, video_path: `${reqA}/output/final.mp4` };
  const url = await getSignedVideoUrlForRequest(own, A, sign);
  assert.ok(url?.includes(`${reqA}/output/final.mp4`));
  assert.deepEqual(calls, [`${reqA}/output/final.mp4`]);
  // Attempt-scoped Reel outputs and the Long Form thumbnail are also under the request prefix.
  assert.equal(ownedVideoPath({ id: reqA, user_id: A, video_path: `${reqA}/attempt-2/final.mp4` }, A), `${reqA}/attempt-2/final.mp4`);
  assert.equal(ownedVideoPath({ id: reqA, user_id: A, video_path: `${reqA}/output/thumbnail.jpg` }, A), `${reqA}/output/thumbnail.jpg`);
});

test("B3-1b: the dashboard pages sign only through the owner-scoped helper, never the raw path helper", () => {
  const root = path.join(__dirname, "../../app/dashboard");
  for (const file of ["videos/[id]/page.tsx", "page.tsx"]) {
    const src = readFileSync(path.join(root, file), "utf8");
    assert.ok(!/getSignedVideoUrl\(/.test(src), `${file}: raw getSignedVideoUrl(path) call remains`);
    assert.ok(/getSignedVideoUrlForRequest\(/.test(src), `${file}: owner-scoped signing missing`);
  }
});

test("B3-2: a legitimate signing is never logged — no console.* in the signing helper; the pages' console lines carry DB errors only, never a URL, token or signature", () => {
  const helper = readFileSync(path.join(__dirname, "signed-url.ts"), "utf8");
  assert.ok(!/console\./.test(helper), "signed-url.ts logs nothing, so no redaction is needed here");
  const root = path.join(__dirname, "../../app/dashboard");
  for (const file of ["videos/[id]/page.tsx", "page.tsx"]) {
    const src = readFileSync(path.join(root, file), "utf8");
    for (const line of src.split("\n").filter((l) => /console\./.test(l))) {
      assert.ok(!/signedUrl|videoUrl|thumbnailUrl|token|X-Amz|Signature/i.test(line), `${file}: log line touches a signed URL: ${line.trim()}`);
    }
  }
});

test("B3-3: the app's own INSERTs never set status beyond pending/script_ready, video_path, created_at, render_attempts or another user's id — the direct-PostgREST hole is a policy, not app code", () => {
  const files = ["src/app/dashboard/new/actions.ts", "src/app/dashboard/long-form/new/actions.ts"];
  const forbidden = /\b(video_path|created_at|render_attempts|long_form_confirmed_at|long_form_production_plan|avatar_generation_started_at)\s*:/;
  let inserts = 0;
  for (const file of files) {
    const src = readFileSync(path.join(__dirname, "../../..", file), "utf8");
    const re = /from\("video_requests"\)\s*\.insert\(\{([\s\S]*?)\}\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      inserts++;
      const body = m[1];
      assert.ok(!forbidden.test(body), `${file}: insert sets a server-owned column:\n${body}`);
      assert.match(body, /user_id:\s*user\.id/, `${file}: insert must bind user_id to the session user`);
      const status = /status:\s*"([a-z_]+)"/.exec(body);
      if (status) assert.ok(status[1] === "pending" || status[1] === "script_ready", `${file}: insert may only create pre-render rows, got ${status[1]}`);
    }
  }
  assert.ok(inserts >= 3, `expected the three customer inserts, found ${inserts}`);
});
