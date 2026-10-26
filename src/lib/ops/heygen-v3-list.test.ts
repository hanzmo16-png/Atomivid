import test from "node:test";
import assert from "node:assert/strict";
import { heygenAbsenceClaimAllowed, parseHeygenVideoListBody, readHeygenVideoList } from "./provider-config";

const video = (id: string, created_at: number) => ({ id, status: "completed", created_at, video_url: "https://files.heygen.ai/video/private.mp4" });

test("SIMULATED GET /v3/videos: id + next_token, not the retired v1 envelope", async () => {
  const urls: string[] = [];
  let page = 0;
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    page += 1;
    if (page === 1) return Response.json({ data: [video("v_page_1", 1_700_000_000)], has_more: true, next_token: "cursor-2" });
    return Response.json({ data: [video("v_page_2", 1_600_000_000)], has_more: false, next_token: null });
  }) as typeof fetch;
  const listed = await readHeygenVideoList(fetchImpl, "fixture-key");
  assert.equal(listed.failure, null);
  assert.deepEqual(listed.videos.map((v) => v.id), ["v_page_1", "v_page_2"]);
  assert.equal(urls[0], "https://api.heygen.com/v3/videos?limit=100");
  assert.equal(urls[1], "https://api.heygen.com/v3/videos?limit=100&token=cursor-2");
  assert.equal(listed.oldestListedAt, new Date(1_600_000_000 * 1000).toISOString());
  assert.doesNotMatch(urls.join(" "), /v1\/video\.list/);
});

test("SIMULATED legacy v1 list is a failure, never an empty account", async () => {
  const legacy = { data: { videos: [{ video_id: "legacy-1", status: "completed", created_at: 10 }], token: "next" }, warning: { v3_endpoint: "GET /v3/videos", sunset_date: "2026-10-31" } };
  assert.deepEqual(parseHeygenVideoListBody(legacy), { ok: false, failure: "legacy_envelope" });
  const listed = await readHeygenVideoList((async () => Response.json(legacy)) as typeof fetch, "fixture-key");
  assert.equal(listed.failure, "legacy_envelope");
  assert.equal(listed.videos.length, 0);
  assert.equal(listed.pages, 0);
});

test("SIMULATED auth failure and bounded 429 do not invent a complete list", async () => {
  const denied = await readHeygenVideoList((async () => new Response("{}", { status: 401 })) as typeof fetch, "fixture-key");
  assert.equal(denied.failure, "unauthorized");
  assert.equal(denied.pages, 0);
  let hits = 0;
  const limited = await readHeygenVideoList((async () => {
    hits += 1;
    if (hits < 3) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
    return Response.json({ data: [video("v_after_limit", 1_700_000_100)], has_more: false, next_token: null });
  }) as typeof fetch, "fixture-key");
  assert.equal(limited.failure, null);
  assert.equal(limited.videos[0]?.id, "v_after_limit");
  assert.equal(hits, 3);
  const stuck = await readHeygenVideoList((async () => new Response("{}", { status: 429, headers: { "retry-after": "0" } })) as typeof fetch, "fixture-key");
  assert.equal(stuck.failure, "rate_limited");
});

test("SIMULATED incomplete v3 page is not treated as coverage", () => {
  assert.equal(parseHeygenVideoListBody({ data: [{ video_id: "wrong-field", status: "completed" }], has_more: false }).ok, false);
  assert.equal(parseHeygenVideoListBody({ data: [{ id: "v_ok", status: "pending", created_at: null }], has_more: false, next_token: null }).ok, true);
});

test("SIMULATED omitted has_more is not an empty account; an explicit empty page is", async () => {
  assert.equal(parseHeygenVideoListBody({ data: [] }).ok, false);
  const omitted = await readHeygenVideoList((async () => Response.json({ data: [] })) as typeof fetch, "fixture-key");
  assert.equal(omitted.failure, "incomplete");
  assert.equal(omitted.pages, 0);
  assert.equal(omitted.videos.length, 0);
  assert.equal(heygenAbsenceClaimAllowed(omitted), false);
  const empty = await readHeygenVideoList((async () => Response.json({ data: [], has_more: false, next_token: null })) as typeof fetch, "fixture-key");
  assert.equal(empty.failure, null);
  assert.equal(empty.pages, 1);
  assert.equal(empty.videos.length, 0);
  assert.equal(heygenAbsenceClaimAllowed(empty), true);
});

test("SIMULATED a video with null created_at blocks an absence claim", async () => {
  const body = { data: [{ id: "v_undated", status: "completed", created_at: null }], has_more: false, next_token: null };
  const listed = await readHeygenVideoList((async () => Response.json(body)) as typeof fetch, "fixture-key");
  assert.equal(listed.videos.length, 1);
  assert.equal(listed.failure, "incomplete");
  assert.equal(heygenAbsenceClaimAllowed(listed), false);
});

test("SIMULATED HTTP error, truncated page, repeated cursor and the 20-page cap are not coverage", async () => {
  const denied = await readHeygenVideoList((async () => new Response("{}", { status: 403 })) as typeof fetch, "fixture-key");
  assert.equal(denied.failure, "unauthorized");
  assert.equal(heygenAbsenceClaimAllowed(denied), false);
  let step = 0;
  const partial = await readHeygenVideoList((async () => {
    step += 1;
    if (step === 1) return Response.json({ data: [video("v_kept", 1_700_000_000)], has_more: true, next_token: "cursor-2" });
    return new Response("{}", { status: 500 });
  }) as typeof fetch, "fixture-key");
  assert.equal(partial.failure, "incomplete");
  assert.equal(partial.videos.length, 1);
  assert.equal(heygenAbsenceClaimAllowed(partial), false);
  const repeated = await readHeygenVideoList((async () => Response.json({ data: [video("v_loop", 1_700_000_000)], has_more: true, next_token: "same" })) as typeof fetch, "fixture-key");
  assert.equal(repeated.failure, "incomplete");
  assert.equal(repeated.pages, 2);
  let n = 0;
  const capped = await readHeygenVideoList((async () => {
    n += 1;
    return Response.json({ data: [video(`v_${n}`, 1_700_000_000 + n)], has_more: true, next_token: `cursor-${n}` });
  }) as typeof fetch, "fixture-key");
  assert.equal(capped.pages, 20);
  assert.equal(capped.failure, "incomplete");
  assert.equal(heygenAbsenceClaimAllowed(capped), false);
  const dropped = await readHeygenVideoList((async () => { throw new Error("simulated reset"); }) as typeof fetch, "fixture-key");
  assert.equal(dropped.failure, "transport");
  assert.equal(dropped.videos.length, 0);
});
