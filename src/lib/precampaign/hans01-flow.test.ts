/**
 * hans-01 (Codex correction chatgpt-22): delivery before payment and a cumulative USD 1.20 cap across every
 * run and resume. Synthetic stores and providers only: nothing here touches a network, Supabase or Drive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryLedgerStore, type PaidOperation } from "@/lib/production-intelligence/ledger";
import { paidCallKey, type PaidCallSpec } from "@/lib/paid-calls/gate";
import { admitPaidCall, budgetHoldKey, ceilCents, memoryProjectBudgetStore, projectExposure, ProjectBudgetExceededError, ProjectReservationMismatchError, ProjectUncertainStateError } from "@/lib/paid-calls/project-budget";
import { runHans01, SpendAboveReservationError, type ClipKey, type Hans01Deps } from "./hans01-flow";

const P = "precampaign-hans01-test";
const NOW = () => "2026-10-12T00:00:00.000Z";
type Audio = { seconds: number; id: string };

function world(opts: { voiceUsd?: number; clipSeconds?: Record<ClipKey, number>; clipActualUsd?: Partial<Record<ClipKey, number>>; walletDrop?: Partial<Record<ClipKey, number>>; photo?: string } = {}) {
  const ledger = memoryLedgerStore();
  const budget = memoryProjectBudgetStore(ledger.ops);
  const calls = { voice: 0, apertura: 0, cierre: 0, delivered: 0 };
  const stored = new Map<string, string>();
  let wallet = 48.87;
  const voiceSpec: PaidCallSpec = { projectId: P, shotId: "voice:full", provider: "elevenlabs", model: "eleven_multilingual_v2", method: "tts_with_timestamps", inputFingerprint: { text: "guion" }, reservedUsd: opts.voiceUsd ?? 0.1278 };
  const seconds = opts.clipSeconds ?? { apertura: 5.1, cierre: 3.4 };
  const deps: Hans01Deps<string, Audio, string, string> = {
    projectId: P, capUsd: 1.2, ledger, budget,
    deliveryPreflight: async () => {},
    voice: { spec: voiceSpec, hooks: {
      call: async ({ key }) => { calls.voice++; stored.set(key, "voz"); return { result: "voz", costUsd: voiceSpec.reservedUsd, resultRef: key }; },
      load: async (ref) => stored.get(ref) ?? null, now: NOW } },
    avatarUsdPerSecond: 0.05, avatarAllowanceSeconds: 12,
    cut: async () => ({ apertura: { seconds: seconds.apertura, id: "a" }, cierre: { seconds: seconds.cierre, id: "c" } }),
    clip: (k, a) => ({
      spec: { projectId: P, shotId: `avatar:${k}`, provider: "heygen", model: "avatar-iv-photo", method: "image_audio_video", inputFingerprint: { photo: opts.photo ?? "p1", audio: a.id }, reservedUsd: a.seconds * 0.05 },
      hooks: {
        call: async ({ key }) => { calls[k]++; wallet -= opts.walletDrop?.[k] ?? 0; stored.set(key, `mp4:${k}`); return { result: `mp4:${k}`, costUsd: opts.clipActualUsd?.[k] ?? ceilCents(a.seconds * 0.05), resultRef: key }; },
        load: async (ref) => stored.get(ref) ?? null, now: NOW },
    }),
    observeAccountUsd: async () => wallet,
    deliver: async () => { calls.delivered++; return "ok"; },
  };
  return { deps, ledger, budget, calls, voiceSpec };
}

const paidCalls = (c: { voice: number; apertura: number; cierre: number }) => c.voice + c.apertura + c.cierre;
const seed = (ops: Map<string, PaidOperation>, key: string, status: PaidOperation["status"], reservedUsd: number, committedUsd: number | null) =>
  ops.set(key, { idempotencyKey: key, projectId: P, shotId: key, provider: "heygen", model: "x", method: "m", attemptKind: "initial", reservedUsd, committedUsd, status, providerJobId: null, resultRef: null, updatedAt: NOW() });

test("delivery route unavailable → zero TTS and zero HeyGen calls, no budget hold", async () => {
  const w = world();
  w.deps.deliveryPreflight = async () => { throw new Error("delivery_route_not_approved"); };
  await assert.rejects(runHans01(w.deps), /delivery_route_not_approved/);
  assert.equal(paidCalls(w.calls), 0);
  assert.equal(w.budget.holds.size, 0);
  assert.equal(w.ledger.ops.size, 0);
});

test("happy path: one voice + two clips, every hold settled, cumulative exposure ≤ cap", async () => {
  const w = world();
  const r = await runHans01(w.deps);
  assert.deepEqual(w.calls, { voice: 1, apertura: 1, cierre: 1, delivered: 1 });
  assert.ok(r.exposureAtEndUsd <= 1.2);
  assert.equal(r.exposureAtEndUsd, 0.13 + 0.26 + 0.17);
  assert.ok([...w.budget.holds.values()].every((h) => h.status === "COMMITTED"));
});

test("(a) resume reuses stored voice and clips: no new provider call and the cumulative total is not reset", async () => {
  const w = world();
  const first = await runHans01(w.deps);
  const again = await runHans01(w.deps);
  assert.deepEqual(w.calls, { voice: 1, apertura: 1, cierre: 1, delivered: 2 });
  assert.equal(again.voice.reused, true);
  assert.equal(again.clips.apertura.reused && again.clips.cierre.reused, true);
  assert.equal(again.exposureAtStartUsd, first.exposureAtEndUsd);
  assert.equal(again.exposureAtEndUsd, first.exposureAtEndUsd);
  assert.equal(w.budget.holds.size, 3, "no new hold on reuse");
});

test("(b) history USD 0.90 + a call whose bound is USD 0.40 is refused before any provider call", async () => {
  const ledger = memoryLedgerStore();
  const budget = memoryProjectBudgetStore(ledger.ops);
  seed(ledger.ops, "op_history", "COMMITTED", 0.5, 0.9);
  await assert.rejects(admitPaidCall(budget, { projectId: P, forKey: "op_next", usd: 0.4, capUsd: 1.2 }), ProjectBudgetExceededError);
  assert.equal(budget.holds.size, 0);
  // Same through the flow: history leaves no room for the voice + avatar plan → zero calls.
  const w = world();
  seed(w.ledger.ops, "op_history", "COMMITTED", 0.5, 0.9);
  await assert.rejects(runHans01(w.deps), ProjectBudgetExceededError);
  assert.equal(paidCalls(w.calls), 0);
});

test("(c) an uncertain call blocks any other fingerprint and still counts at its full reservation", async () => {
  const w = world();
  seed(w.ledger.ops, "op_uncertain_other_photo", "RECONCILIATION_REQUIRED", 0.3, null);
  await assert.rejects(runHans01(w.deps), ProjectUncertainStateError);
  assert.equal(paidCalls(w.calls), 0);
  // The uncertain row still counts at its full reservation.
  assert.equal(projectExposure([], [...w.ledger.ops.values()]).usd, 0.3);
  // A clip with a different photo fingerprint after an uncertain clip of this plan is refused at admission.
  const v = world();
  const k1 = paidCallKey({ projectId: P, shotId: "avatar:apertura", provider: "heygen", model: "avatar-iv-photo", method: "image_audio_video", inputFingerprint: { photo: "p1", audio: "a" }, reservedUsd: 0 });
  seed(v.ledger.ops, k1, "SUBMITTED", 0.26, null);
  await assert.rejects(admitPaidCall(v.budget, { projectId: P, forKey: "op_other_fingerprint", usd: 0.2, capUsd: 1.2 }), ProjectUncertainStateError);
});

test("(d) attributed spend above the reservation stops the run before the second avatar", async () => {
  const byCost = world({ clipActualUsd: { apertura: 0.4 } });
  await assert.rejects(runHans01(byCost.deps), SpendAboveReservationError);
  assert.deepEqual(byCost.calls, { voice: 1, apertura: 1, cierre: 0, delivered: 0 });
  // Account observation (wallet delta) above the reservation also stops it, and the hold keeps the larger amount.
  const byWallet = world({ walletDrop: { apertura: 0.5 } });
  await assert.rejects(runHans01(byWallet.deps), SpendAboveReservationError);
  assert.equal(byWallet.calls.cierre, 0);
  const held = [...byWallet.budget.holds.values()].find((h) => h.actualUsd === 0.5);
  assert.ok(held, "observed delta recorded conservatively");
});

test("(e) two concurrent runs with different fingerprints never exceed the cap", async () => {
  const ledger = memoryLedgerStore();
  const budget = memoryProjectBudgetStore(ledger.ops);
  const results = await Promise.allSettled([
    admitPaidCall(budget, { projectId: P, forKey: "op_run_A", usd: 0.7, capUsd: 1.2 }),
    admitPaidCall(budget, { projectId: P, forKey: "op_run_B", usd: 0.7, capUsd: 1.2 }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.some((r) => r.status === "rejected" && r.reason instanceof ProjectBudgetExceededError));
  assert.ok(projectExposure(await budget.listHolds(P), await budget.listOps(P)).usd <= 1.2);

  // Two full runs racing on the same plan pay each item at most once.
  const w = world();
  await Promise.allSettled([runHans01(w.deps), runHans01(w.deps)]);
  assert.ok(w.calls.voice <= 1 && w.calls.apertura <= 1 && w.calls.cierre <= 1);
  assert.ok(projectExposure(await w.budget.listHolds(P), await w.budget.listOps(P)).usd <= 1.2);
});

test("reservations round UP to the cent; avatar plan re-checked with the real durations before HeyGen", async () => {
  assert.equal(ceilCents(0.1278), 0.13);
  assert.equal(ceilCents(0.17), 0.17);
  assert.equal(ceilCents(0.1701), 0.18);
  const w = world({ clipSeconds: { apertura: 10, cierre: 12 } }); // 1.10 of avatar after a 0.13 voice > 1.20
  await assert.rejects(runHans01(w.deps), ProjectBudgetExceededError);
  assert.deepEqual(w.calls, { voice: 1, apertura: 0, cierre: 0, delivered: 0 });
});

// ---- Correction 2 (chatgpt-24): replay of a delivered run with high history; reuse never hides a new payment.

test("full replay of a delivered run that spent USD 0.90 recovers everything: zero calls, zero new holds, same exposure", async () => {
  const w = world({ clipSeconds: { apertura: 8, cierre: 7.4 } }); // 0.13 voice + 0.40 + 0.37 = 0.90
  const first = await runHans01(w.deps);
  assert.equal(first.exposureAtEndUsd, 0.9);
  const holds = w.budget.holds.size;
  const again = await runHans01(w.deps); // e63090c refused this: 0.90 + 0.60 allowance > 1.20
  assert.deepEqual(w.calls, { voice: 1, apertura: 1, cierre: 1, delivered: 2 });
  assert.equal(w.budget.holds.size, holds);
  assert.equal(again.exposureAtStartUsd, 0.9);
  assert.equal(again.exposureAtEndUsd, 0.9);
  assert.ok(again.voice.reused && again.clips.apertura.reused && again.clips.cierre.reused);
});

test("replay of a run that ended exactly at the USD 1.20 cap (with unrelated history) makes no call and is not refused", async () => {
  const w = world({ clipSeconds: { apertura: 8, cierre: 7.4 } });
  seed(w.ledger.ops, "op_other_history", "COMMITTED", 0.3, 0.3); // 0.30 + 0.13 + 0.40 + 0.37 = 1.20
  const r = await runHans01(w.deps);
  assert.equal(r.exposureAtEndUsd, 1.2);
  const again = await runHans01(w.deps);
  assert.equal(again.exposureAtEndUsd, 1.2);
  assert.deepEqual(w.calls, { voice: 1, apertura: 1, cierre: 1, delivered: 2 });
});

test("partial replay (voice + opening committed, closing missing) admits only the missing clip", async () => {
  const w = world({ clipSeconds: { apertura: 8, cierre: 7.4 } });
  const clip = w.deps.clip;
  let crash = true;
  w.deps.clip = (k, a) => {
    const s = clip(k, a);
    // The closing clip's first attempt is refused by the provider before acceptance (REFUNDED, cost 0).
    return k === "cierre" && crash ? { ...s, hooks: { ...s.hooks, classify: () => ({ kind: "rejected" }), call: async () => { crash = false; throw new Error("http 400"); } } } : s;
  };
  await assert.rejects(runHans01(w.deps));
  assert.deepEqual({ v: w.calls.voice, a: w.calls.apertura }, { v: 1, a: 1 });
  const exposureAfterFailure = projectExposure(await w.budget.listHolds(P), await w.budget.listOps(P)).usd;
  assert.equal(exposureAfterFailure, 0.53, "voice 0.13 + opening 0.40; the refused closing call counts 0");
  // The refused key is final (never re-paid). A changed closing input (new audio) is a new, admitted call.
  w.deps.cut = async () => ({ apertura: { seconds: 8, id: "a" }, cierre: { seconds: 7.4, id: "c2" } });
  const r = await runHans01(w.deps);
  assert.deepEqual({ v: w.calls.voice, a: w.calls.apertura, c: w.calls.cierre }, { v: 1, a: 1, c: 1 });
  assert.equal(r.exposureAtEndUsd, 0.9);
});

test("a REFUNDED (refused) call is never paid again: real gate, zero calls, zero exposure added", async () => {
  const w = world();
  const key = paidCallKey(w.voiceSpec, 0);
  seed(w.ledger.ops, key, "REFUNDED", 0.13, 0);
  w.ledger.ops.get(key)!.resultRef = "rejected:rejected:http 400";
  await assert.rejects(runHans01(w.deps));
  assert.equal(paidCalls(w.calls), 0);
  assert.equal(projectExposure(await w.budget.listHolds(P), await w.budget.listOps(P)).usd, 0);
  assert.equal(w.budget.holds.size, 0);
});

test("an earlier, cheaper reservation never covers a more expensive call (hold without row, or RESERVED row)", async () => {
  const w = world();
  const key = paidCallKey(w.voiceSpec, 0);
  await w.budget.insertHold({ key: budgetHoldKey(P, 0), projectId: P, forKey: key, usd: 0.05, createdAt: NOW() });
  await assert.rejects(runHans01(w.deps), ProjectReservationMismatchError);
  assert.equal(paidCalls(w.calls), 0);

  const v = world();
  const k = paidCallKey(v.voiceSpec, 0);
  seed(v.ledger.ops, k, "RESERVED", 0.05, null);
  await assert.rejects(runHans01(v.deps), ProjectReservationMismatchError);
  assert.equal(paidCalls(v.calls), 0);
});

test("a RESERVED row that already covers the call (crash before submit) is paid once and counted once", async () => {
  const w = world();
  const key = paidCallKey({ ...w.voiceSpec, reservedUsd: 0.13 }, 0);
  seed(w.ledger.ops, key, "RESERVED", 0.13, null);
  const r = await runHans01(w.deps);
  assert.equal(w.calls.voice, 1);
  assert.equal(r.exposureAtEndUsd, 0.13 + 0.26 + 0.17, "voice counted once, not row + new hold");
});

test("rejected retries are never attempted under an unadmitted ordinal", async () => {
  const w = world();
  const orig = w.deps.voice.hooks;
  let calls = 0;
  w.deps.voice = { ...w.deps.voice, hooks: { ...orig, maxRejectedRetries: 3, classify: () => ({ kind: "rejected" }), call: async () => { calls++; throw new Error("http 400"); } } };
  await assert.rejects(runHans01(w.deps));
  assert.equal(calls, 1);
  assert.equal(w.ledger.ops.size, 1);
  assert.equal(projectExposure(await w.budget.listHolds(P), await w.budget.listOps(P)).usd, 0);
});
