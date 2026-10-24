/**
 * Audit #200 (Claude, claude/audit-pr200 @ bead03f, src/lib/podcast/audit-pr200.test.ts) turned into normal tests: the
 * `todo` cases there are the defects; here they are required behaviour. Fail on 6ce9fcb, pass after the fix (CI job
 * `repro-before-after` runs this file against the 6ce9fcb implementation and expects these failures).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ensurePodcastSpendAuthorization, type RpcClient } from "./spend-authorization-open";

const EP = "2a000000-0000-4000-8000-0000000000e2";
type Out = { data?: unknown; error?: { code?: string; message?: string } | null } | "hang";
const rpc = (open: Out, usage?: Out): RpcClient & { calls: string[] } => {
  const c = { calls: [] as string[], rpc(fn: string) { c.calls.push(fn); const out = fn === "pi_spend_authorization_usage" ? (usage ?? { data: null }) : open;
    return out === "hang" ? new Promise<never>(() => {}) : Promise.resolve({ data: out.data ?? null, error: out.error ?? null }); } };
  return c;
};
const st = (x: Awaited<ReturnType<typeof ensurePodcastSpendAuthorization>>) => [x.ok, "status" in x ? x.status : 0];
// Old signature compatibility: (db, ep, cap, ref) — the 4th argument is the ref in both versions.

test("P0-2 #1: RPC missing (PGRST202) → 503, never ok", async () => {
  const r = await ensurePodcastSpendAuthorization(rpc({ error: { code: "PGRST202", message: "Could not find the function public.pi_open_spend_authorization" } }), EP, 1.2, "ref");
  assert.deepEqual(st(r), [false, 503]);
});
test("P0-2 #2: undefined function (42883) → 503", async () => {
  const r = await ensurePodcastSpendAuthorization(rpc({ error: { code: "42883", message: "function public.pi_open_spend_authorization(uuid, numeric, text) does not exist" } }), EP, 1.2, "ref");
  assert.deepEqual(st(r), [false, 503]);
});
test("P0-2 #3: schema-cache/signature message without code → 503", async () => {
  const r = await ensurePodcastSpendAuthorization(rpc({ error: { message: "Could not find the function public.pi_open_spend_authorization(p_cap, p_episode_id, p_ref) in the schema cache" } }), EP, 1.2, "ref");
  assert.deepEqual(st(r), [false, 503]);
});
test("P0-2 #4: RPC that never answers is bounded by a timeout → 503", async () => {
  const r = await Promise.race([ensurePodcastSpendAuthorization(rpc("hang"), EP, 1.2, "ref", { timeoutMs: 100 }), new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 2000))]);
  assert.notEqual(r, "timeout"); assert.deepEqual(st(r as never), [false, 503]);
});
test("P0-2 #5: RPC client that throws → 503", async () => {
  const r = await ensurePodcastSpendAuthorization({ rpc: () => Promise.reject(new Error("fetch failed")) }, EP, 1.2, "ref");
  assert.deepEqual(st(r), [false, 503]);
});
test("generic RPC error, uncertain operations and refusal stay fail-closed (503/409)", async () => {
  assert.deepEqual(st(await ensurePodcastSpendAuthorization(rpc({ error: { code: "57014", message: "canceling statement due to statement timeout" } }), EP, 1.2, "r")), [false, 503]);
  assert.deepEqual(st(await ensurePodcastSpendAuthorization(rpc({ error: { code: "", message: "TypeError: fetch failed" } }), EP, 1.2, "r")), [false, 503]);
  assert.deepEqual(st(await ensurePodcastSpendAuthorization(rpc({ data: { opened: false, reason: "uncertain operations must be reconciled first" } }), EP, 1.2, "r")), [false, 409]);
  assert.deepEqual(st(await ensurePodcastSpendAuthorization(rpc({ data: { opened: false, reason: "episode not found" } }), EP, 1.2, "r")), [false, 409]);
});
test("P1-1: existing authorization with LESS remaining than this run needs → 409 before dispatch", async () => {
  const r = await ensurePodcastSpendAuthorization(rpc({ data: { opened: false, reason: "already_open" } }, { data: { status: "ACTIVE", capUsd: 0.5, remainingUsd: 0.05 } }), EP, 2.4, "r");
  assert.deepEqual(st(r), [false, 409]);
});
test("P1-1: already_open with unreadable usage → 503; closed → 409; enough remaining → ok", async () => {
  assert.deepEqual(st(await ensurePodcastSpendAuthorization(rpc({ data: { opened: false, reason: "already_open" } }, { error: { code: "PGRST202" } }), EP, 1, "r")), [false, 503]);
  assert.deepEqual(st(await ensurePodcastSpendAuthorization(rpc({ data: { opened: false, reason: "already_open" } }, { data: { status: "CLOSED", capUsd: 5, remainingUsd: 5 } }), EP, 1, "r")), [false, 409]);
  const okr = await ensurePodcastSpendAuthorization(rpc({ data: { opened: false, reason: "already_open" } }, { data: { status: "ACTIVE", capUsd: 5, remainingUsd: 3 } }), EP, 2.4, "r");
  assert.equal(okr.ok, true);
});
test("nothing to pay → no RPC at all", async () => {
  const c = rpc({ data: { opened: true } });
  assert.equal((await ensurePodcastSpendAuthorization(c, EP, 0, "r")).ok, true);
  assert.equal(c.calls.length, 0);
});
