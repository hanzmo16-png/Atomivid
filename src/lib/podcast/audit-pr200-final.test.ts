/**
 * Final independent audit of PR #200 (head 7153c35, branch grok/podcast-audiovisual-cierre) — USD 0, no network.
 * The five gate defects reproduced on 6ce9fcb (Claude audit bead03f, marked `todo` there) are asserted here as plain
 * regressions, plus new adversarial cases for the already_open path added by a446b8b / 5f3fb08.
 * Run: node --import tsx --test src/lib/podcast/audit-pr200-final.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ensurePodcastSpendAuthorization, type RpcClient } from "./spend-authorization-open";

const EP = "2a000000-0000-4000-8000-0000000000e2";
type Out = { data?: unknown; error?: { code?: string; message?: string } | null } | "hang" | "throw";
/** Scripted RPC: one answer per function name; records every call (fn + args). */
const rpc = (answers: Record<string, Out>) => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const out = answers[fn] ?? { error: { code: "PGRST202", message: `unexpected ${fn}` } };
      if (out === "hang") return new Promise<never>(() => {});
      if (out === "throw") return Promise.reject(new Error("fetch failed"));
      return Promise.resolve({ data: out.data ?? null, error: out.error ?? null });
    },
  };
  return { db, calls };
};
const status = (r: Awaited<ReturnType<typeof ensurePodcastSpendAuthorization>>) => (r.ok ? 200 : r.status);
const fast = { timeoutMs: 150 };

// 1) authorization missing / refused / timeout (defect 1 of the audit) ─────────────────────────────────────────────
test("D1a RPC missing (PGRST202) → 503, never dispatch (was fail-open on 6ce9fcb)", async () => {
  const { db } = rpc({ pi_open_spend_authorization: { error: { code: "PGRST202", message: "Could not find the function public.pi_open_spend_authorization" } } });
  assert.equal(status(await ensurePodcastSpendAuthorization(db, EP, 1.2, "ref", fast)), 503);
});
test("D1b undefined function (42883) → 503", async () => {
  const { db } = rpc({ pi_open_spend_authorization: { error: { code: "42883", message: "function public.pi_open_spend_authorization(uuid, numeric, text) does not exist" } } });
  assert.equal(status(await ensurePodcastSpendAuthorization(db, EP, 1.2, "ref", fast)), 503);
});
test("D1c schema-cache message without code → 503 (no regex shortcut to 'not installed')", async () => {
  const { db } = rpc({ pi_open_spend_authorization: { error: { message: "Could not find the function public.pi_open_spend_authorization(p_cap, p_episode_id, p_ref) in the schema cache" } } });
  assert.equal(status(await ensurePodcastSpendAuthorization(db, EP, 1.2, "ref", fast)), 503);
});
test("D1d RPC that never answers is bounded → 503 within the timeout", async () => {
  const { db } = rpc({ pi_open_spend_authorization: "hang" });
  const t0 = Date.now();
  const r = await ensurePodcastSpendAuthorization(db, EP, 1.2, "ref", fast);
  assert.equal(status(r), 503);
  assert.ok(Date.now() - t0 < 1500, "bounded by the timeout");
});
test("D1e network throw → 503", async () => {
  const { db } = rpc({ pi_open_spend_authorization: "throw" });
  assert.equal(status(await ensurePodcastSpendAuthorization(db, EP, 1.2, "ref", fast)), 503);
});
test("D1f explicit refusals → 409 (episode not found, uncertain operations, unknown reason)", async () => {
  for (const reason of ["episode not found", "uncertain operations must be reconciled first", "owner mismatch", ""]) {
    const { db } = rpc({ pi_open_spend_authorization: { data: { opened: false, reason } } });
    assert.equal(status(await ensurePodcastSpendAuthorization(db, EP, 1.2, "ref", fast)), 409, reason);
  }
});
test("D1g default timeout is finite and ≤ 10 s (production value)", async () => {
  const mod = await import("./spend-authorization-open");
  assert.ok(mod.SPEND_AUTHORIZATION_RPC_TIMEOUT_MS > 0 && mod.SPEND_AUTHORIZATION_RPC_TIMEOUT_MS <= 10_000);
});

// 2) insufficient budget / narration → video recovery (defect 2) ───────────────────────────────────────────────────
test("D2a already_open with a remaining amount SMALLER than this run needs → 409 before dispatch (was ok on 6ce9fcb)", async () => {
  const { db, calls } = rpc({
    pi_open_spend_authorization: { data: { opened: false, reason: "already_open" } },
    pi_spend_authorization_usage: { data: { status: "ACTIVE", capUsd: 0.5, remainingUsd: 0.05 } },
  });
  const r = await ensurePodcastSpendAuthorization(db, EP, 0.5, "r", { ...fast, neededUsd: 2.4 });
  assert.equal(status(r), 409);
  assert.deepEqual(calls.map((c) => c.fn), ["pi_open_spend_authorization", "pi_spend_authorization_usage"]);
  assert.equal(calls[1].args.p_project_id, `podcast-${EP}`, "usage is read for THIS episode's project");
});
test("D2b already_open with enough remaining → ok, reports the real immutable cap (narration → video under one authorization)", async () => {
  const { db } = rpc({
    pi_open_spend_authorization: { data: { opened: false, reason: "already_open" } },
    pi_spend_authorization_usage: { data: { status: "ACTIVE", capUsd: "3.00", remainingUsd: "2.55" } },
  });
  const r = await ensurePodcastSpendAuthorization(db, EP, 3, "r", { ...fast, neededUsd: 2.4 });
  assert.ok(r.ok && r.state === "already_open" && r.capUsd === 3 && r.remainingUsd === 2.55, JSON.stringify(r));
});
test("D2c already_open but the authorization is CLOSED/EXHAUSTED → 409", async () => {
  for (const st of ["CLOSED", "EXHAUSTED", "REVOKED", undefined]) {
    const { db } = rpc({
      pi_open_spend_authorization: { data: { opened: false, reason: "already_open" } },
      pi_spend_authorization_usage: { data: { status: st, capUsd: 3, remainingUsd: 3 } },
    });
    assert.equal(status(await ensurePodcastSpendAuthorization(db, EP, 3, "r", { ...fast, neededUsd: 1 })), 409, String(st));
  }
});
test("D2d already_open and the usage read hangs / errors / returns nothing / NaN → fail closed (503 or 409), never ok", async () => {
  const cases: Out[] = ["hang", "throw", { error: { code: "57014", message: "statement timeout" } }, { data: null }, { data: { status: "ACTIVE", capUsd: 3, remainingUsd: "abc" } }];
  for (const u of cases) {
    const { db } = rpc({ pi_open_spend_authorization: { data: { opened: false, reason: "already_open" } }, pi_spend_authorization_usage: u });
    const r = await ensurePodcastSpendAuthorization(db, EP, 3, "r", { ...fast, neededUsd: 1 });
    assert.equal(r.ok, false, JSON.stringify(u));
  }
});
test("D2e needed exactly equal to remaining is accepted; one cent more is refused", async () => {
  const mk = (needed: number) => {
    const { db } = rpc({ pi_open_spend_authorization: { data: { opened: false, reason: "already_open" } }, pi_spend_authorization_usage: { data: { status: "ACTIVE", capUsd: 1, remainingUsd: 0.4 } } });
    return ensurePodcastSpendAuthorization(db, EP, 1, "r", { ...fast, neededUsd: needed });
  };
  assert.equal((await mk(0.4)).ok, true);
  assert.equal((await mk(0.41)).ok, false);
});

// 3) caps: the opened cap is bounded by the DB maximum and rounded UP to cents ──────────────────────────────────────
test("D3a cap is rounded up to cents and never above USD 100", async () => {
  const { db, calls } = rpc({ pi_open_spend_authorization: { data: { opened: true } } });
  await ensurePodcastSpendAuthorization(db, EP, 1.231, "r", fast);
  assert.equal(calls[0].args.p_cap_usd, 1.24);
  const big = rpc({ pi_open_spend_authorization: { data: { opened: true } } });
  await ensurePodcastSpendAuthorization(big.db, EP, 5000, "r", fast);
  assert.equal(big.calls[0].args.p_cap_usd, 100);
});
test("D3b a run needing more than the owner cap opens AT MOST max(cap, need) — documented behaviour, the DB stays the final word", async () => {
  const { db, calls } = rpc({ pi_open_spend_authorization: { data: { opened: true } } });
  await ensurePodcastSpendAuthorization(db, EP, 1, "r", { ...fast, neededUsd: 2 });
  // FINDING candidate: the gate opens the authorization with max(capUsd, neededUsd). The caller must pass the owner's
  // approved budget as capUsd and a need ≤ that budget; see the route test in scripts/qa/audit-pr200-final-db.sh (F1).
  assert.equal(calls[0].args.p_cap_usd, 2);
});
test("D3c nothing to pay → no RPC at all", async () => {
  const { db, calls } = rpc({});
  assert.equal((await ensurePodcastSpendAuthorization(db, EP, 0, "r", fast)).ok, true);
  assert.equal((await ensurePodcastSpendAuthorization(db, EP, null, "r", { ...fast, neededUsd: 0 })).ok, true);
  assert.equal(calls.length, 0);
});
