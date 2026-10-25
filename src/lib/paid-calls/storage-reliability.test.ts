/**
 * M4 (reliability): a paid voice/music result must survive a TRANSIENT storage failure. The provider has already charged
 * when the result is written; marking it "unstored" on the first error loses a recoverable asset for good (a restarted
 * worker can neither reuse it nor pay again, so the request is blocked). Persistent failures keep today's contract:
 * one provider call, no re-pay. The sidecar is written before the bytes, so a persistent failure never leaves paid
 * bytes durable without the metadata needed to reuse them. USD 0: fake providers and in-memory store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatedMusicTrack, gatedVoiceSynthesize, type StorageRetry } from "./gated-providers";
import { memoryResultStore, type PaidResultStore } from "./result-store";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { PaidResultUnavailableError } from "./errors";

const audio = Buffer.from("paid-audio-bytes");

type Writes = { putBytes: number; putJson: number };
type FlakyStore = PaidResultStore & { writes: Writes; objects: Map<string, Buffer> };
function flakyStore(failures: { putBytes?: number; putJson?: number }): FlakyStore {
  const inner = memoryResultStore();
  const left = { putBytes: failures.putBytes ?? 0, putJson: failures.putJson ?? 0 };
  const writes: Writes = { putBytes: 0, putJson: 0 };
  return {
    objects: inner.objects, writes,
    async putBytes(path, bytes, type) { writes.putBytes++; if (left.putBytes-- > 0) throw new Error("storage 503"); return inner.putBytes(path, bytes, type); },
    async putJson(path, value) { writes.putJson++; if (left.putJson-- > 0) throw new Error("storage 503"); return inner.putJson(path, value); },
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

  test(`${label}: persistent putJson failure → bounded attempts, no orphaned paid bytes, restart refuses to re-pay`, async () => {
    const c = make(); const store = flakyStore({ putJson: 99 }); const ledger = memoryLedgerStore();
    const first = await c.run(store, ledger, noWait);
    assert.deepEqual(first.audioBuffer, audio, "the in-process result is still returned");
    assert.equal(store.writes.putJson, 3, "putJson attempts bounded to the default 3");
    assert.equal(store.writes.putBytes, 0, "bytes are not written without their sidecar");
    assert.deepEqual(audioObjects(store), [], "no paid bytes durable without metadata");
    const row = onlyRow(ledger);
    assert.equal(row.status, "COMMITTED");
    assert.ok(String(row.resultRef).startsWith("unstored:"));
    await assert.rejects(c.run(store, ledger, noWait), PaidResultUnavailableError);
    assert.equal(c.calls(), 1, "never paid twice");
  });

  test(`${label}: persistent putBytes failure after the sidecar → bounded attempts, missing bytes fail verification, restart refuses to re-pay`, async () => {
    const c = make(); const store = flakyStore({ putBytes: 99 }); const ledger = memoryLedgerStore();
    await c.run(store, ledger, noWait);
    assert.equal(store.writes.putJson, 1);
    assert.equal(store.writes.putBytes, 3, "putBytes attempts bounded to the default 3");
    assert.equal(jsonObjects(store).length, 1, "sidecar present");
    assert.deepEqual(audioObjects(store), [], "bytes truly absent");
    assert.ok(String(onlyRow(ledger).resultRef).startsWith("unstored:"));
    await assert.rejects(c.run(store, ledger, noWait), PaidResultUnavailableError);
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
