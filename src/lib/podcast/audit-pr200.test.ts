/**
 * Independent audit of PR #200 (head 6ce9fcb, branch grok/podcast-audiovisual-cierre) — reproducible, USD 0.
 * Adversarial cases for ensurePodcastSpendAuthorization (the gate the generate/video routes call BEFORE dispatch).
 * A case marked `todo` documents a defect: it asserts the fail-closed behaviour the audit requires and currently fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ensurePodcastSpendAuthorization, type RpcClient } from "./spend-authorization-open";

const EP = "2a000000-0000-4000-8000-0000000000e2";
const rpc = (out: { data?: unknown; error?: { code?: string; message?: string } | null } | "hang"): RpcClient & { calls: number } => {
  const c = { calls: 0, rpc() { c.calls++; return out === "hang" ? new Promise<never>(() => {}) : Promise.resolve({ data: out.data ?? null, error: out.error ?? null }); } };
  return c;
};

test("P0-2 audit #200: RPC missing (PGRST202) must refuse — never dispatch", { todo: "fail-open: returns ok/not_installed and the route dispatches" }, async () => {
  const r = await ensurePodcastSpendAuthorization(rpc({ error: { code: "PGRST202", message: "Could not find the function public.pi_open_spend_authorization" } }), EP, 1.2, "ref");
  assert.equal(r.ok, false);
});

test("P0-2 audit #200: undefined function (42883) must refuse", { todo: "fail-open: returns ok/not_installed" }, async () => {
  const r = await ensurePodcastSpendAuthorization(rpc({ error: { code: "42883", message: "function public.pi_open_spend_authorization(uuid, numeric, text) does not exist" } }), EP, 1.2, "ref");
  assert.equal(r.ok, false);
});

test("P0-2 audit #200: a schema-cache/signature message alone is enough to fail open (no code)", { todo: "regex on the message turns a renamed parameter into 'not installed'" }, async () => {
  const r = await ensurePodcastSpendAuthorization(rpc({ error: { message: "Could not find the function public.pi_open_spend_authorization(p_cap, p_episode_id, p_ref) in the schema cache" } }), EP, 1.2, "ref");
  assert.equal(r.ok, false);
});

test("audit #200: RPC that never answers must be bounded (timeout → 503), not hang the request", { todo: "no timeout around db.rpc" }, async () => {
  const r = await Promise.race([ensurePodcastSpendAuthorization(rpc("hang"), EP, 1.2, "ref"), new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 300))]);
  assert.notEqual(r, "timeout");
});

test("audit #200: generic RPC error, uncertain operations and refusal are fail-closed (503/409)", async () => {
  assert.deepEqual(await ensurePodcastSpendAuthorization(rpc({ error: { code: "57014", message: "canceling statement due to statement timeout" } }), EP, 1.2, "r").then((x) => [x.ok, "status" in x ? x.status : 0]), [false, 503]);
  assert.deepEqual(await ensurePodcastSpendAuthorization(rpc({ error: { code: "", message: "TypeError: fetch failed" } }), EP, 1.2, "r").then((x) => [x.ok, "status" in x ? x.status : 0]), [false, 503]);
  assert.deepEqual(await ensurePodcastSpendAuthorization(rpc({ data: { opened: false, reason: "uncertain operations must be reconciled first" } }), EP, 1.2, "r").then((x) => [x.ok, "status" in x ? x.status : 0]), [false, 409]);
  assert.deepEqual(await ensurePodcastSpendAuthorization(rpc({ data: { opened: false, reason: "episode not found" } }), EP, 1.2, "r").then((x) => [x.ok, "status" in x ? x.status : 0]), [false, 409]);
});

test("P1 audit #200: an existing authorization with a SMALLER cap than this run needs must not be reported as ok", { todo: "already_open → ok with capUsd null; the run starts and the DB stops it mid-way (cap is immutable)" }, async () => {
  // Narration started alone opened USD 0.50; the later production needs USD 2.40 for this run.
  const r = await ensurePodcastSpendAuthorization(rpc({ data: { opened: false, reason: "already_open" } }), EP, 2.4, "r");
  assert.equal(r.ok, false, "the route cannot know the remaining cap → it must read pi_spend_authorization_usage (or refuse) before dispatch");
});

test("audit #200: nothing to pay → no RPC at all", async () => {
  const c = rpc({ data: { opened: true } });
  assert.equal((await ensurePodcastSpendAuthorization(c, EP, 0, "r")).ok, true);
  assert.equal(c.calls, 0);
});
