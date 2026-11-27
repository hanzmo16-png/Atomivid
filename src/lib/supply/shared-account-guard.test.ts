import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guardPaidCall, paidCallKey, type PaidCallSpec } from "@/lib/paid-calls/gate";
import { memoryLedgerStore, type PaidOperation } from "@/lib/production-intelligence/ledger";
import { SupplyUnavailableError } from "./policy";
import { submitWithSupply } from "./server";
import { SHARED_FAL_ALIASES } from "./shared-account-guard";

const policies = (flux: boolean, recraft: boolean) => [{ provider: "flux", enabled: flux }, { provider: "recraft", enabled: recraft }];
function harness(initial: unknown = policies(true, true)) {
  let rows = initial, readError = false, countOverride: number | null | undefined;
  const memory = memoryLedgerStore();
  const calls = { policies: 0, rpc: 0, paid: 0, refresh: 0 };
  const answers: { submitted: boolean; reason?: string }[] = [];
  const service = {
    from(table: string) {
      assert.equal(table, "pi_supply_policies");
      return { select(fields: string, options: unknown) { assert.equal(fields, "provider,enabled"); assert.deepEqual(options, { count: "exact" }); return { async in(field: string, aliases: string[]) {
        assert.equal(field, "provider"); assert.deepEqual([...aliases].sort(), [...SHARED_FAL_ALIASES].sort());
        calls.policies++; return { data: rows, count: countOverride === undefined ? (Array.isArray(rows) ? rows.length : null) : countOverride, error: readError ? { message: "offline read failure" } : null };
      } }; } };
    },
    async rpc(name: string, args: { p_key: string }) {
      assert.equal(name, "pi_submit_with_supply"); calls.rpc++;
      const next = answers.shift();
      if (next) return { data: next, error: null };
      const submitted = await memory.update(args.p_key, "RESERVED", { status: "SUBMITTED" });
      return { data: { submitted, reason: submitted ? "admitted" : "already_claimed" }, error: null };
    },
  };
  const store = { ...memory, submit: (op: PaidOperation) => submitWithSupply(service as never, op) };
  const spec = (provider: string): PaidCallSpec => ({ projectId: "offline-shared-wallet", shotId: "image:1", provider, model: provider, method: "generate_image", inputFingerprint: { prompt: "synthetic offline case" }, reservedUsd: 0.05 });
  const run = (provider: string) => guardPaidCall(store, spec(provider), { call: async () => { calls.paid++; return { result: "asset", costUsd: 0.05, resultRef: "asset" }; }, load: async () => "asset" });
  return { calls, memory, service, answers, spec, run, store, setRows: (value: unknown) => { rows = value; }, failRead: () => { readError = true; }, setCount: (v: number | null) => { countOverride = v; } };
}
for (const alias of SHARED_FAL_ALIASES) test(`${alias}: both shared policies enabled stop before RPC/paid transition and keep RESERVED`, async () => {
  const h = harness();
  await assert.rejects(h.run(alias), (e: unknown) => e instanceof SupplyUnavailableError && e.diagnosticId === "SUPPLY-WAIT" && !e.waitsForNextPeriod);
  assert.equal(h.calls.rpc, 0); assert.equal(h.calls.paid, 0);
  assert.equal(h.memory.ops.get(paidCallKey(h.spec(alias)))?.status, "RESERVED");
});
test("concurrent Flux and Recraft calls sharing the wallet both remain RESERVED without RPC or paid HTTP", async () => {
  const h = harness();
  const results = await Promise.allSettled([h.run("flux"), h.run("recraft")]);
  assert.ok(results.every(r => r.status === "rejected" && r.reason instanceof SupplyUnavailableError));
  assert.equal(h.memory.ops.size, 2);
  assert.ok([...h.memory.ops.values()].every(op => op.status === "RESERVED"));
  assert.equal(h.calls.rpc, 0); assert.equal(h.calls.paid, 0);
});
test("shared policy read errors, missing rows, duplicates and malformed booleans cannot authorize", async () => {
  const invalid = [null, [], [policies(false, true)[1]], [{ provider: "flux", enabled: true }, { provider: "flux", enabled: false }], [{ provider: "flux", enabled: "true" }, { provider: "recraft", enabled: false }], [{ provider: "fal", enabled: true }, { provider: "recraft", enabled: false }]];
  for (const rows of invalid) {
    const h = harness(rows); await assert.rejects(h.run("flux"), SupplyUnavailableError);
    assert.equal(h.calls.rpc, 0); assert.equal(h.calls.paid, 0);
    assert.equal(h.memory.ops.get(paidCallKey(h.spec("flux")))?.status, "RESERVED");
  }
  const h = harness(policies(true, false)); h.failRead();
  await assert.rejects(h.run("flux"), SupplyUnavailableError);
  assert.equal(h.calls.rpc, 0); assert.equal(h.calls.paid, 0);
});
test("Recraft works without optional Flux policy; absent current Flux policy cannot authorize a call", async () => {
  const rows = [{ provider: "recraft", enabled: true }];
  const recraft = harness(rows);
  await recraft.run("recraft");
  assert.equal(recraft.calls.rpc, 1); assert.equal(recraft.calls.paid, 1);
  const flux = harness(rows);
  await assert.rejects(flux.run("flux"), SupplyUnavailableError);
  assert.equal(flux.calls.rpc, 0); assert.equal(flux.calls.paid, 0);
  assert.equal(flux.memory.ops.get(paidCallKey(flux.spec("flux")))?.status, "RESERVED");
  const failedRead = harness(rows); failedRead.failRead();
  await assert.rejects(failedRead.run("recraft"), SupplyUnavailableError);
  assert.equal(failedRead.calls.rpc, 0);
});
test("missing or truncated policy count is unavailable, never proof of an absent peer", async () => {
  for (const count of [null, 2, -1, 0.5]) {
    const h = harness([{ provider: "recraft", enabled: true }]); h.setCount(count);
    await assert.rejects(h.run("recraft"), SupplyUnavailableError);
    assert.equal(h.calls.rpc, 0); assert.equal(h.calls.paid, 0);
  }
});
for (const alias of SHARED_FAL_ALIASES) test(`${alias}: one enabled alias retains atomic admission and committed replay idempotence`, async () => {
  const h = harness(policies(alias === "flux", alias === "recraft"));
  await h.run(alias);
  assert.equal(h.calls.rpc, 1); assert.equal(h.calls.paid, 1);
  assert.equal(h.memory.ops.get(paidCallKey(h.spec(alias)))?.status, "COMMITTED");
  h.setRows(policies(true, true));
  await h.run(alias);
  assert.equal(h.calls.rpc, 1); assert.equal(h.calls.paid, 1);
  assert.equal(h.calls.policies, 1, "already committed results replay before new admission, even while aliases are now blocked");
});
test("already accepted recorded Fal job resumes without a new admission or paid submit", async () => {
  const h = harness(), s = h.spec("flux"), key = paidCallKey(s);
  await h.memory.insert({ idempotencyKey: key, projectId: s.projectId, shotId: s.shotId, provider: s.provider, model: s.model, method: s.method,
    reservedUsd: s.reservedUsd, status: "PROVIDER_JOB_RECORDED", attemptKind: "initial", providerJobId: "existing-fal-job", committedUsd: null, resultRef: null, updatedAt: "2026-11-26T00:00:00Z" });
  let resumes = 0;
  await guardPaidCall(h.store, s, { call: async () => { throw new Error("new paid submit forbidden"); }, load: async () => "asset", resume: async id => {
    assert.equal(id, "existing-fal-job"); resumes++; return { result: "asset", costUsd: 0.05, resultRef: "asset" };
  } });
  assert.equal(resumes, 1); assert.equal(h.calls.rpc, 0); assert.equal(h.calls.policies, 0); assert.equal(h.calls.paid, 0);
  assert.equal(h.memory.ops.get(key)?.status, "COMMITTED");
});
test("single-alias already_claimed and disabled-current-policy decisions remain the RPC's", async () => {
  const h = harness(policies(true, false));
  h.answers.push({ submitted: false, reason: "already_claimed" });
  assert.equal(await submitWithSupply(h.service as never, { provider: "flux", idempotencyKey: "raced", reservedUsd: 0.05 } as PaidOperation), false);
  assert.equal(h.calls.rpc, 1);
  h.setRows(policies(false, true)); h.answers.push({ submitted: false, reason: "disabled" });
  await assert.rejects(h.run("flux"), (e: unknown) => e instanceof SupplyUnavailableError && e.reason === "disabled");
  assert.equal(h.calls.rpc, 2); assert.equal(h.calls.paid, 0);
});
test("stale refresh cannot admit a second RPC after both aliases become enabled", async () => {
  const h = harness(policies(true, false)); h.answers.push({ submitted: false, reason: "balance unverified or stale" });
  await assert.rejects(submitWithSupply(h.service as never, { provider: "flux", idempotencyKey: "stale", reservedUsd: 0.05 } as PaidOperation, {
    refresh: async () => { h.calls.refresh++; h.setRows(policies(true, true)); return true; },
  }), SupplyUnavailableError);
  assert.equal(h.calls.rpc, 1); assert.equal(h.calls.policies, 2); assert.equal(h.calls.refresh, 1); assert.equal(h.calls.paid, 0);
});
test("unrelated providers retain RPC semantics without reading shared alias policies", async () => {
  const h = harness(null); h.answers.push({ submitted: false, reason: "already_claimed" });
  assert.equal(await submitWithSupply(h.service as never, { provider: "anthropic", idempotencyKey: "other", reservedUsd: 0.05 } as PaidOperation), false);
  assert.equal(h.calls.policies, 0); assert.equal(h.calls.rpc, 1);
});
test("all four product image routes retain the shared durable submission guard", () => {
  const reel = readFileSync("src/lib/video/generate-video.ts", "utf8"), resolver = readFileSync("src/lib/video/visual-resource-resolver.ts", "utf8");
  const produce = readFileSync("src/lib/video/long-form/produce.ts", "utf8"), shots = readFileSync("src/lib/video/long-form/shot-executor.ts", "utf8");
  const ledger = readFileSync("src/lib/paid-calls/supabase-ledger-store.ts", "utf8"), core = readFileSync("src/lib/production-intelligence/ledger.ts", "utf8");
  for (const route of ["resolveFluxReelScene", "resolveRecraftReelScene"]) assert.match(reel, new RegExp(`${route}\\(\\{\\s*ledger: gate\\.ledger`));
  assert.match(reel, /supabaseLedgerStore\(supabase\)/);
  assert.match(resolver, /guardPaidCall[\s\S]*?\(\s*ledger,/);
  assert.match(produce, /ledger: runtime\.paidCalls\?\.ledger \?\? supabaseLedgerStore\(supabase\)/);
  assert.match(produce, /executeShot\([\s\S]*?ledger: paidCalls\.ledger/);
  assert.match(shots, /guardPaidCall<GenerativeAsset>\(\s*ledgerFor\(deps\)/);
  assert.match(shots, /provider: deps\.imageProvider\.name/);
  assert.match(ledger, /store\.submit = op => submitWithSupply\(supabase, op\)/);
  assert.match(core, /store\.submit\(cur, now\(\)\)/);
});


test("peer absence is safe only because existing SQL refuses unconfigured providers before SUBMITTED", () => {
  const state = readFileSync("supabase/migrations/20261014183400_finished_podcast_image_slot.sql", "utf8");
  const core = readFileSync("supabase/migrations/20261005150229_provider_supply_job_reservations.sql", "utf8");
  const wrapper = readFileSync("supabase/migrations/20261020150535_reel_provider_spend_cap.sql", "utf8");
  assert.match(state, /select \* into p from public\.pi_supply_policies where provider=p_provider;\s*if not found or not p\.enabled/);
  assert.match(state, /'level','UNKNOWN','reason','policy unconfigured'/);
  const unknownCheck = core.indexOf("if state->>'level'='UNKNOWN' then return jsonb_build_object('submitted',false");
  const transition = core.indexOf("update public.pi_paid_operations set status='SUBMITTED'");
  assert.ok(unknownCheck > 0 && transition > unknownCheck);
  assert.match(wrapper, /return public\.pi_submit_with_supply_core\(p_key, p_units\)/);
});
