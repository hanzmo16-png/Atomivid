/**
 * M4 (reliability): a paid voice/music result must survive a TRANSIENT storage failure. The provider has already charged
 * when the result is written; marking it "unstored" on the first error loses a recoverable asset for good (a restarted
 * worker can neither reuse it nor pay again, so the request is blocked). Persistent failures keep today's contract:
 * one provider call, no re-pay. The bytes are written before the sidecar: readers treat an existing sidecar as
 * "delivered and stored" (podcast productionSpend, hasStoredVoiceMeta), so a sidecar must never exist without its bytes,
 * or a crash between the writes would hide an uncertain charge. USD 0: fake providers and in-memory store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatedMusicTrack, gatedVoiceSynthesize, hasStoredVoiceMeta, type StorageRetry } from "./gated-providers";
import { memoryResultStore, paidResultPath, type PaidResultStore } from "./result-store";
import { memoryLedgerStore, ReconciliationRequiredError } from "@/lib/production-intelligence/ledger";
import { summarizeSpend } from "@/lib/podcast/pilot";
import { PaidResultUnavailableError } from "./errors";

const audio = Buffer.from("paid-audio-bytes");

type Writes = { putBytes: number; putJson: number };
type FlakyStore = PaidResultStore & { writes: Writes; objects: Map<string, Buffer> };
function flakyStore(failures: { putBytes?: number; putJson?: number; hangJson?: boolean }): FlakyStore {
  const inner = memoryResultStore();
  const left = { putBytes: failures.putBytes ?? 0, putJson: failures.putJson ?? 0 };
  const writes: Writes = { putBytes: 0, putJson: 0 };
  return {
    objects: inner.objects, writes,
    async putBytes(path, bytes, type) { writes.putBytes++; if (left.putBytes-- > 0) throw new Error("storage 503"); return inner.putBytes(path, bytes, type); },
    async putJson(path, value) {
      writes.putJson++;
      if (failures.hangJson) return new Promise<void>(() => {}); // worker dies during the sidecar write
      if (left.putJson-- > 0) throw new Error("storage 503");
      return inner.putJson(path, value);
    },
    getBytes: (p) => inner.getBytes(p),
    getJson: (p) => inner.getJson(p),
  };
}

type Ledger = ReturnType<typeof memoryLedgerStore>;
type Case = {
  name: string;
  /** One paid call against the given store/ledger (same request and inputs every time, like a restarted worker). */
  run: (store: PaidResultStore, ledger: Ledger, retry: StorageRetry) => Promise<{ reused: boolean; costUsd: number; audioBuffer: Buffer }>;
  calls: () => number;
  requestId: string;
};

function voiceCase(): Case {
  let calls = 0;
  const voiceProvider = {
    name: "elevenlabs",
    async synthesize() { calls++; return { audioBuffer: audio, durationSeconds: 1.5, words: [], mimeType: "audio/mpeg", extension: "mp3" }; },
  };
  return {
    name: "voice (elevenlabs)",
    calls: () => calls,
    requestId: "req-1",
    run: (results, ledger, storageRetry) => gatedVoiceSynthesize({
      ledger, results, requestId: "req-1", storageRetry, voiceProvider,
      voiceIdentity: { voiceId: "v1", modelId: "eleven_multilingual_v2", voiceSettingsJson: "{}" }, estimatedCostUsd: 0.05,
    } as never, "hola", "es"),
  };
}

function musicCase(): Case {
  let calls = 0;
  const musicProvider = { name: "beatoven", async getTrack() { calls++; return { audioBuffer: audio, durationSeconds: 30, mimeType: "audio/mpeg", extension: "mp3" }; } };
  return {
    name: "music (beatoven)",
    calls: () => calls,
    requestId: "req-2",
    run: (results, ledger, storageRetry) => gatedMusicTrack({ ledger, results, requestId: "req-2", musicProvider, estimatedCostUsd: 0.4, storageRetry } as never, { durationSeconds: 30 } as never),
  };
}

const noWait = { retryDelayMs: () => 0 };
const audioObjects = (store: FlakyStore) => [...store.objects.keys()].filter((k) => !k.endsWith(".json"));
const jsonObjects = (store: FlakyStore) => [...store.objects.keys()].filter((k) => k.endsWith(".json"));
const onlyRow = (ledger: Ledger) => { const rows = [...ledger.ops.values()]; assert.equal(rows.length, 1); return rows[0]; };

for (const make of [voiceCase, musicCase]) {
  const label = make().name;

  test(`${label}: transient putBytes failure → stored; a restarted worker reuses it at USD 0 (provider called once)`, async () => {
    const c = make(); const store = flakyStore({ putBytes: 1 }); const ledger = memoryLedgerStore();
    const first = await c.run(store, ledger, noWait);
    assert.equal(first.reused, false);
    const row = onlyRow(ledger);
    assert.equal(row.status, "COMMITTED");
    assert.ok(!String(row.resultRef).startsWith("unstored:"), `paid result must be stored, got ${row.resultRef}`);
    const again = await c.run(store, ledger, noWait);
    assert.equal(again.reused, true); assert.equal(again.costUsd, 0);
    assert.deepEqual(again.audioBuffer, audio);
    assert.equal(c.calls(), 1, "provider called exactly once");
  });

  test(`${label}: transient putJson failure (2×) is retried; restart reuses at USD 0`, async () => {
    const c = make(); const store = flakyStore({ putJson: 2 }); const ledger = memoryLedgerStore();
    await c.run(store, ledger, noWait);
    const again = await c.run(store, ledger, noWait);
    assert.equal(again.reused, true); assert.equal(again.costUsd, 0); assert.equal(c.calls(), 1);
  });

  test(`${label}: persistent putJson failure after the bytes → bounded attempts, bytes kept at the deterministic path, no sidecar, restart refuses to re-pay`, async () => {
    const c = make(); const store = flakyStore({ putJson: 99 }); const ledger = memoryLedgerStore();
    const first = await c.run(store, ledger, noWait);
    assert.deepEqual(first.audioBuffer, audio, "the in-process result is still returned");
    assert.equal(store.writes.putBytes, 1);
    assert.equal(store.writes.putJson, 3, "putJson attempts bounded to the default 3");
    const [audioPath] = audioObjects(store);
    assert.deepEqual(store.objects.get(audioPath), audio, "paid bytes durable at the deterministic path");
    assert.deepEqual(jsonObjects(store), [], "no sidecar: nothing reads this result as stored");
    const row = onlyRow(ledger);
    assert.equal(row.status, "COMMITTED");
    assert.ok(String(row.resultRef).startsWith("unstored:"));
    await assert.rejects(c.run(store, ledger, noWait), PaidResultUnavailableError);
    assert.equal(c.calls(), 1, "never paid twice");
  });

  test(`${label}: persistent putBytes failure → bounded attempts, no sidecar written, restart refuses to re-pay`, async () => {
    const c = make(); const store = flakyStore({ putBytes: 99 }); const ledger = memoryLedgerStore();
    await c.run(store, ledger, noWait);
    assert.equal(store.writes.putBytes, 3, "putBytes attempts bounded to the default 3");
    assert.equal(store.writes.putJson, 0, "the sidecar is never written without its bytes");
    assert.deepEqual([...store.objects.keys()], [], "nothing stored");
    assert.ok(String(onlyRow(ledger).resultRef).startsWith("unstored:"));
    await assert.rejects(c.run(store, ledger, noWait), PaidResultUnavailableError);
    assert.equal(c.calls(), 1, "never paid twice");
  });

  test(`${label}: crash between the writes (bytes stored, sidecar write never finishes) → the charge stays UNCERTAIN, never "delivered"; restart refuses to re-pay`, async () => {
    const c = make(); const store = flakyStore({ hangJson: true }); const ledger = memoryLedgerStore();
    void c.run(store, ledger, noWait); // the worker dies here: the call never returns
    for (let i = 0; i < 50 && store.writes.putJson === 0; i++) await new Promise((r) => setImmediate(r));
    assert.equal(store.writes.putJson, 1, "the sidecar write started");
    const row = onlyRow(ledger);
    assert.equal(row.status, "SUBMITTED");
    assert.equal(audioObjects(store).length, 1, "bytes stored");
    assert.deepEqual(jsonObjects(store), [], "no sidecar");
    // Same rule as podcast productionSpend: an open row counts as delivered only if its sidecar exists.
    const stored = new Set<string>();
    if (await store.getJson(paidResultPath(c.requestId, row.idempotencyKey, "json"))) stored.add(row.idempotencyKey);
    const spend = summarizeSpend([{ idempotency_key: row.idempotencyKey, status: row.status, reserved_usd: row.reservedUsd, committed_usd: null }], stored);
    assert.equal(spend.uncertain, 1, "the possible charge without a stored result is reported as uncertain");
    assert.equal(spend.deliveredOpenUsd, 0);
    await assert.rejects(c.run(store, ledger, noWait), ReconciliationRequiredError);
    assert.equal(c.calls(), 1, "never paid twice");
  });

  test(`${label}: stored bytes that no longer match the sidecar are refused (integrity check not weakened)`, async () => {
    const c = make(); const store = flakyStore({}); const ledger = memoryLedgerStore();
    await c.run(store, ledger, noWait);
    const [audioPath] = audioObjects(store);
    store.objects.set(audioPath, Buffer.from("tampered-bytes!!"));
    await assert.rejects(c.run(store, ledger, noWait), PaidResultUnavailableError);
    assert.equal(c.calls(), 1);
  });

  test(`${label}: a non-integer or non-finite attempts value falls back to 3 (never an unbounded loop)`, async () => {
    for (const [attempts, expected] of [[Number.NaN, 3], [Number.POSITIVE_INFINITY, 3], [2.5, 3], [-1, 1], [50, 5]] as const) {
      const c = make(); const store = flakyStore({ putJson: 99 });
      await c.run(store, memoryLedgerStore(), { ...noWait, attempts });
      assert.equal(store.writes.putJson, expected, `attempts=${attempts}`);
      assert.equal(c.calls(), 1);
    }
  });
}

test("voice: crash between the writes → hasStoredVoiceMeta stays false (the pending-narration estimate does not count the chunk as already stored)", async () => {
  const c = voiceCase(); const store = flakyStore({ hangJson: true });
  void c.run(store, memoryLedgerStore(), noWait);
  for (let i = 0; i < 50 && store.writes.putJson === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(audioObjects(store).length, 1, "bytes stored");
  const deps = { results: store, requestId: "req-1", voiceProvider: { name: "elevenlabs" }, voiceIdentity: { voiceId: "v1", modelId: "eleven_multilingual_v2", voiceSettingsJson: "{}" } };
  assert.equal(await hasStoredVoiceMeta(deps, "hola", "es"), false);
});
