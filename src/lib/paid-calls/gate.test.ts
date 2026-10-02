/**
 * PI V2 Fase B1 — RB-01 double-charge guard. Mocks only: nothing here touches a network.
 * Mandatory cases (user-specified):
 *  1. the mock charges and then the connection is cut: exactly one call;
 *  2. a second attempt with the same key leaves the call count at 1;
 *  3. a failure before acceptance is not retried by default (COST-A2: billing is uncertain).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryLedgerStore, ReconciliationRequiredError } from "@/lib/production-intelligence/ledger";
import { GenerativeProviderError } from "@/lib/providers/types";
import { commitRecordedPaidJob, guardPaidCall, paidCallKey, type PaidCallSpec } from "./gate";
import { PaidLedgerUnavailableError, PaidResultUnavailableError, ProviderRejectedError } from "./errors";
import { gatedMusicTrack, gatedVoiceSynthesize } from "./gated-providers";
import { memoryResultStore } from "./result-store";
import type { MusicProvider, VoiceProvider } from "@/lib/providers/types";

const NOW = () => "2026-10-02T00:00:00.000Z";
const spec: PaidCallSpec = { projectId: "req-1", shotId: "voice:abc", provider: "elevenlabs", model: "eleven_multilingual_v2", method: "tts_with_timestamps", inputFingerprint: { text: "hola" }, reservedUsd: 0.01 };

class ConnectionCut extends Error {}

test("B1-1/2: the mock charges then the connection is cut → one call; the same key never calls again (RECONCILIATION_REQUIRED)", async () => {
  const store = memoryLedgerStore();
  let calls = 0;
  const mock = async () => {
    calls++;
    throw new ConnectionCut("socket hang up after the provider accepted");
  };
  const hooks = { call: mock, load: async () => null, now: NOW };

  await assert.rejects(guardPaidCall(store, spec, hooks), ConnectionCut);
  assert.equal(calls, 1);
  const row = store.ops.get(paidCallKey(spec))!;
  assert.equal(row.status, "RECONCILIATION_REQUIRED");

  // Attempt 2 (new render_attempts, same request, same input): refused before any HTTP.
  await assert.rejects(guardPaidCall(store, spec, hooks), ReconciliationRequiredError);
  assert.equal(calls, 1);
  // Attempt 3 as well.
  await assert.rejects(guardPaidCall(store, spec, hooks), ReconciliationRequiredError);
  assert.equal(calls, 1);
  assert.equal(store.ops.get(paidCallKey(spec))!.status, "RECONCILIATION_REQUIRED");
});

test("B1-3: a refusal before acceptance is not retried automatically (COST-A2), and a later attempt does not call again", async () => {
  const store = memoryLedgerStore();
  let calls = 0;
  const hooks = {
    call: async () => {
      calls++;
      throw new ProviderRejectedError(`HTTP 503 on submit #${calls}`);
    },
    load: async () => null,
    now: NOW,
  };
  await assert.rejects(guardPaidCall(store, spec, hooks), /HTTP 503 on submit #1/);
  assert.equal(calls, 1, "no automatic retry");
  assert.equal(store.ops.get(paidCallKey(spec, 0))!.status, "REFUNDED");
  assert.equal(store.ops.get(paidCallKey(spec, 0))!.committedUsd, 0);
  assert.equal(store.ops.has(paidCallKey(spec, 1)), false, "no ordinal-1 row");

  // A later attempt finds the row refunded: no second call.
  await assert.rejects(guardPaidCall(store, spec, hooks), PaidResultUnavailableError);
  assert.equal(calls, 1);
});

test("B1-3b: with an explicit opt-in retry, a refusal then a success → two calls, COMMITTED on the retry key; the next attempt reuses with zero calls", async () => {
  const store = memoryLedgerStore();
  let calls = 0;
  const hooks = {
    maxRejectedRetries: 1,
    call: async () => {
      calls++;
      if (calls === 1) throw new ProviderRejectedError("HTTP 500 on submit");
      return { result: "audio-bytes", costUsd: 0.01, resultRef: "ref-1" };
    },
    load: async (ref: string) => (ref === "ref-1" ? "audio-bytes" : null),
    now: NOW,
  };
  const first = await guardPaidCall(store, spec, hooks);
  assert.deepEqual([first.result, first.reused, first.attemptOrdinal, calls], ["audio-bytes", false, 1, 2]);
  const second = await guardPaidCall(store, spec, hooks);
  assert.deepEqual([second.result, second.reused, second.costUsd, calls], ["audio-bytes", true, 0, 2]);
});

test("B1-4: 'rejected_final' never retries; 'uncertain' never retries", async () => {
  for (const err of [new ProviderRejectedError("moderation", "rejected_final"), new Error("ETIMEDOUT")]) {
    const store = memoryLedgerStore();
    let calls = 0;
    const hooks = { call: async () => { calls++; throw err; }, load: async () => null, now: NOW };
    await assert.rejects(guardPaidCall(store, spec, hooks), (e: unknown) => e === err);
    assert.equal(calls, 1);
    await assert.rejects(guardPaidCall(store, spec, hooks));
    assert.equal(calls, 1);
  }
});

test("B1-5: the ledger row exists before the HTTP; a ledger that cannot be written means no call", async () => {
  const store = memoryLedgerStore();
  let statusAtCall: string | undefined;
  await guardPaidCall(store, spec, {
    call: async ({ key }) => {
      statusAtCall = store.ops.get(key)?.status;
      return { result: 1, costUsd: 0.01, resultRef: "r" };
    },
    load: async () => 1,
    now: NOW,
  });
  assert.equal(statusAtCall, "SUBMITTED");

  const broken = { ...memoryLedgerStore(), insert: async () => { throw new PaidLedgerUnavailableError("relation does not exist"); } };
  let calls = 0;
  await assert.rejects(guardPaidCall(broken, spec, { call: async () => { calls++; return { result: 1, costUsd: 0, resultRef: "r" }; }, load: async () => null, now: NOW }), PaidLedgerUnavailableError);
  assert.equal(calls, 0);
});

test("B1-6: a success whose result cannot be loaded later is refused, not regenerated", async () => {
  const store = memoryLedgerStore();
  let calls = 0;
  const hooks = { call: async () => { calls++; return { result: "x", costUsd: 0.02, resultRef: "unstored:bucket down" }; }, load: async () => null, now: NOW };
  await guardPaidCall(store, spec, hooks);
  await assert.rejects(guardPaidCall(store, spec, hooks), PaidResultUnavailableError);
  assert.equal(calls, 1);
  assert.equal(store.ops.get(paidCallKey(spec))!.status, "COMMITTED");
});

test("B1-7: a failure that carries a provider job id becomes PROVIDER_JOB_RECORDED; resume commits it; no second submit", async () => {
  const store = memoryLedgerStore();
  let submits = 0;
  const hooks = {
    call: async () => { submits++; throw Object.assign(new Error("poll timeout"), { providerJobId: "job-9" }); },
    load: async () => "clip",
    classify: () => ({ kind: "accepted" as const, providerJobId: "job-9" }),
    now: NOW,
  };
  await assert.rejects(guardPaidCall(store, spec, hooks), /poll timeout/);
  const key = paidCallKey(spec);
  assert.equal(store.ops.get(key)!.status, "PROVIDER_JOB_RECORDED");
  assert.equal(store.ops.get(key)!.providerJobId, "job-9");
  // Same call site without a resume hook: refused, not resubmitted.
  await assert.rejects(guardPaidCall(store, spec, hooks), ReconciliationRequiredError);
  assert.equal(submits, 1);
  // The resume elsewhere stored the clip and closes the row.
  assert.equal(await commitRecordedPaidJob(store, key, { costUsd: 0.5, resultRef: "clip-ref" }, NOW), true);
  const reused = await guardPaidCall(store, spec, hooks);
  assert.deepEqual([reused.result, reused.reused, submits], ["clip", true, 1]);
});

test("B1-8: the key ignores render_attempts and changes with the input", () => {
  const k0 = paidCallKey(spec);
  assert.equal(paidCallKey({ ...spec }), k0);
  assert.notEqual(paidCallKey({ ...spec, inputFingerprint: { text: "hola." } }), k0);
  assert.notEqual(paidCallKey(spec, 1), k0);
});

// ---- Reel adapters: the retry that used to re-pay voice and music now reuses the paid result ----

test("B1-9 Reel voice: attempt 1 pays once; attempt 2 (new process) reuses the stored audio with zero provider calls; a corrupted copy is refused, not re-bought", async () => {
  const ledger = memoryLedgerStore();
  const results = memoryResultStore();
  let calls = 0;
  const voiceProvider: VoiceProvider = {
    name: "elevenlabs",
    async synthesize(text) {
      calls++;
      return { audioBuffer: Buffer.from(`mp3:${text}`), durationSeconds: 1.5, words: [{ text, startSeconds: 0, endSeconds: 1.5 }], mimeType: "audio/mpeg", extension: "mp3" };
    },
  };
  const deps = { ledger, results, requestId: "req-7", voiceProvider, voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" }, estimatedCostUsd: 0.004 };
  const a1 = await gatedVoiceSynthesize(deps, "hola mundo", "es");
  assert.deepEqual([a1.reused, a1.costUsd, calls], [false, 0.004, 1]);
  const a2 = await gatedVoiceSynthesize(deps, "hola mundo", "es");
  assert.deepEqual([a2.reused, a2.costUsd, calls, a2.audioBuffer.toString()], [true, 0, 1, "mp3:hola mundo"]);
  assert.deepEqual(a2.words, a1.words);
  // The speed-corrected call is a different asset: it pays once too, then reuses.
  await gatedVoiceSynthesize(deps, "hola mundo", "es", 1.05);
  await gatedVoiceSynthesize(deps, "hola mundo", "es", 1.05);
  assert.equal(calls, 2);
  // Corrupt the stored audio: refused (no third charge).
  for (const [p, b] of results.objects) if (p.endsWith(".mp3")) results.objects.set(p, Buffer.from(b.toString() + "x"));
  await assert.rejects(gatedVoiceSynthesize(deps, "hola mundo", "es"), PaidResultUnavailableError);
  assert.equal(calls, 2);
});

test("B1-10 Reel music: Beatoven is gated and reused; the curated library passes through free", async () => {
  const ledger = memoryLedgerStore();
  const results = memoryResultStore();
  let calls = 0;
  const beatoven: MusicProvider = { name: "beatoven", async getTrack() { calls++; return { audioBuffer: Buffer.from("mp3"), durationSeconds: 30, mimeType: "audio/mpeg", extension: "mp3" }; } };
  const ctx = { durationSeconds: 30.2, style: "Motivacional", seed: "req-8" };
  const deps = { ledger, results, requestId: "req-8", musicProvider: beatoven, estimatedCostUsd: 0.1 };
  await gatedMusicTrack(deps, ctx);
  const again = await gatedMusicTrack(deps, ctx);
  assert.deepEqual([again.reused, calls], [true, 1]);
  const curated: MusicProvider = { name: "curated-library", async getTrack() { calls++; return { audioBuffer: Buffer.from("mp3"), durationSeconds: 30, mimeType: "audio/mpeg", extension: "mp3" }; } };
  await gatedMusicTrack({ ...deps, musicProvider: curated }, ctx);
  await gatedMusicTrack({ ...deps, musicProvider: curated }, ctx);
  assert.equal(calls, 3);
  assert.equal(ledger.ops.size, 1, "only the generative provider writes ledger rows");
});

// ---- PI V2 COST-A2: upstream_error / rate_limited are economically uncertain → no automatic retry ----

for (const [label, reason] of [["COST-A2-1", "upstream_error"], ["COST-A2-2", "rate_limited"]] as const) {
  test(`${label}: ${reason} → exactly one provider call, no ordinal-1 row; the row ends REFUNDED (SUBMITTED → REFUNDED)`, async () => {
    const store = memoryLedgerStore();
    let calls = 0;
    const err = new GenerativeProviderError(`provider ${reason}`, "elevenlabs", reason);
    const statuses: string[] = [];
    const hooks = {
      call: async ({ key }: { key: string }) => {
        calls++;
        statuses.push(store.ops.get(key)!.status);
        throw err;
      },
      load: async () => null,
      now: NOW,
    };
    await assert.rejects(guardPaidCall(store, spec, hooks), (e: unknown) => e === err);
    assert.equal(calls, 1, "retry automático = 0");
    assert.deepEqual(statuses, ["SUBMITTED"], "the provider is called with the row SUBMITTED");
    const row = store.ops.get(paidCallKey(spec, 0))!;
    assert.equal(row.status, "REFUNDED");
    assert.equal(row.committedUsd, 0);
    assert.ok(row.resultRef?.startsWith("rejected:rejected:"));
    assert.equal(store.ops.has(paidCallKey(spec, 1)), false, "no ordinal-1 row");
    assert.equal(store.ops.size, 1);
  });
}

test("COST-A2-4 (characterization): re-invoking the gate with the same identity after upstream_error / rate_limited is refused with zero calls and no new row", async () => {
  for (const reason of ["upstream_error", "rate_limited"] as const) {
    const store = memoryLedgerStore();
    let calls = 0;
    const hooks = {
      call: async () => {
        calls++;
        throw new GenerativeProviderError(`provider ${reason}`, "elevenlabs", reason);
      },
      load: async () => null,
      now: NOW,
    };
    await assert.rejects(guardPaidCall(store, spec, hooks));
    const after = { ...store.ops.get(paidCallKey(spec, 0))! };
    await assert.rejects(guardPaidCall(store, spec, hooks), PaidResultUnavailableError);
    await assert.rejects(guardPaidCall(store, spec, hooks), PaidResultUnavailableError);
    assert.equal(calls, 1, `${reason}: later invocations never call the provider`);
    assert.equal(store.ops.size, 1, `${reason}: no new operation`);
    assert.deepEqual(store.ops.get(paidCallKey(spec, 0)), after, `${reason}: the REFUNDED row is unchanged`);
  }
});

// ---- PI V2 COST-A2b: even an explicit opt-in cannot retry upstream_error / rate_limited ----

for (const [label, reason] of [["COST-A2b-1", "upstream_error"], ["COST-A2b-2", "rate_limited"]] as const) {
  test(`${label}: maxRejectedRetries: 1 + ${reason} → exactly one provider call, no ordinal-1 row, SUBMITTED → REFUNDED`, async () => {
    for (const maxRejectedRetries of [1, 5]) {
      const store = memoryLedgerStore();
      let calls = 0;
      const err = new GenerativeProviderError(`provider ${reason}`, "elevenlabs", reason);
      const hooks = {
        maxRejectedRetries,
        call: async () => {
          calls++;
          throw err;
        },
        load: async () => null,
        now: NOW,
      };
      await assert.rejects(guardPaidCall(store, spec, hooks), (e: unknown) => e === err);
      assert.equal(calls, 1, `maxRejectedRetries ${maxRejectedRetries}: retry automático = 0`);
      const row = store.ops.get(paidCallKey(spec, 0))!;
      assert.equal(row.status, "REFUNDED");
      assert.equal(row.committedUsd, 0);
      assert.ok(row.resultRef?.startsWith("rejected:rejected:"));
      assert.equal(store.ops.has(paidCallKey(spec, 1)), false, "no ordinal-1 row");
      assert.equal(store.ops.size, 1);
    }
  });
}

test("COST-A2b-3 (negative control): an HTTP refusal tagged 'rejected' without a GenerativeProviderError reason keeps the explicit opt-in retry (unchanged)", async () => {
  const store = memoryLedgerStore();
  let calls = 0;
  const hooks = {
    maxRejectedRetries: 1,
    call: async () => {
      calls++;
      throw new ProviderRejectedError(`HTTP 503 on submit #${calls}`);
    },
    load: async () => null,
    now: NOW,
  };
  await assert.rejects(guardPaidCall(store, spec, hooks), /HTTP 503 on submit #2/);
  assert.equal(calls, 2, "the opt-in retry still applies to this refusal");
  assert.equal(store.ops.get(paidCallKey(spec, 0))!.status, "REFUNDED");
  assert.equal(store.ops.get(paidCallKey(spec, 1))!.status, "REFUNDED");
});
