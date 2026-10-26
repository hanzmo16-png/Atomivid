import test from "node:test";
import assert from "node:assert/strict";
import { parseHeygenVideoListBody, readHeygenVideoList } from "./provider-config";

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
