/**
 * M4 (reliability): a paid voice/music result must survive a TRANSIENT storage failure. The provider has already charged
 * when the result is written; marking it "unstored" on the first error loses a recoverable asset for good (a restarted
 * worker can neither reuse it nor pay again, so the request is blocked). Persistent failures keep today's contract:
 * one provider call, no re-pay. USD 0: fake provider and in-memory store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatedMusicTrack, gatedVoiceSynthesize } from "./gated-providers";
import { memoryResultStore, type PaidResultStore } from "./result-store";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { PaidResultUnavailableError } from "./errors";

const audio = Buffer.from("paid-audio-bytes");

function flakyStore(failures: { putBytes?: number; putJson?: number }) {
  const inner = memoryResultStore();
  const left = { putBytes: failures.putBytes ?? 0, putJson: failures.putJson ?? 0 };
  const writes = { putBytes: 0, putJson: 0 };
  const store: PaidResultStore & { writes: typeof writes; objects: Map<string, Buffer> } = {
    objects: inner.objects, writes,
    async putBytes(path, bytes, type) { writes.putBytes++; if (left.putBytes-- > 0) throw new Error("storage 503"); return inner.putBytes(path, bytes, type); },
    async putJson(path, value) { writes.putJson++; if (left.putJson-- > 0) throw new Error("storage 503"); return inner.putJson(path, value); },
    getBytes: (p) => inner.getBytes(p),
    getJson: (p) => inner.getJson(p),
  };
  return store;
}

function voiceDeps(results: PaidResultStore, ledger = memoryLedgerStore()) {
  let calls = 0;
  const voiceProvider = {
    name: "elevenlabs",
    async synthesize() { calls++; return { audioBuffer: audio, durationSeconds: 1.5, words: [], mimeType: "audio/mpeg", extension: "mp3" }; },
  };
  return { deps: { ledger, results, requestId: "req-1", voiceProvider, voiceIdentity: { voiceId: "v1", modelId: "eleven_multilingual_v2", voiceSettingsJson: "{}" }, estimatedCostUsd: 0.05 }, calls: () => calls, ledger };
}

const noWait = { retryDelayMs: () => 0 };

test("transient putBytes failure: the paid voice is stored and a restarted worker reuses it at USD 0 (provider called once)", async () => {
  const store = flakyStore({ putBytes: 1 });
  const v = voiceDeps(store);
  const first = await gatedVoiceSynthesize({ ...v.deps, storageRetry: noWait } as never, "hola", "es");
  assert.equal(first.reused, false);
  const row = [...v.ledger.ops.values()][0];
  assert.equal(row.status, "COMMITTED");
  assert.ok(!String(row.resultRef).startsWith("unstored:"), `paid result must be stored, got ${row.resultRef}`);
  // worker restart: same ledger + store, same request
  const again = await gatedVoiceSynthesize({ ...v.deps, storageRetry: noWait } as never, "hola", "es");
  assert.equal(again.reused, true); assert.equal(again.costUsd, 0);
  assert.deepEqual(again.audioBuffer, audio);
  assert.equal(v.calls(), 1, "provider called exactly once");
});

test("transient putJson failure (sidecar) is retried too", async () => {
  const store = flakyStore({ putJson: 2 });
  const v = voiceDeps(store);
  await gatedVoiceSynthesize({ ...v.deps, storageRetry: noWait } as never, "hola", "es");
  const again = await gatedVoiceSynthesize({ ...v.deps, storageRetry: noWait } as never, "hola", "es");
  assert.equal(again.reused, true); assert.equal(v.calls(), 1);
});

test("persistent storage failure keeps the contract: one provider call, committed as unstored, a restart refuses to re-pay", async () => {
  const store = flakyStore({ putBytes: 99 });
  const v = voiceDeps(store);
  const first = await gatedVoiceSynthesize({ ...v.deps, storageRetry: noWait } as never, "hola", "es");
  assert.deepEqual(first.audioBuffer, audio, "the in-process result is still returned");
  const row = [...v.ledger.ops.values()][0];
  assert.equal(row.status, "COMMITTED");
  assert.ok(String(row.resultRef).startsWith("unstored:"));
  assert.ok(store.writes.putBytes >= 3 && store.writes.putBytes <= 4, `bounded attempts, got ${store.writes.putBytes}`);
  await assert.rejects(gatedVoiceSynthesize({ ...v.deps, storageRetry: noWait } as never, "hola", "es"), PaidResultUnavailableError);
  assert.equal(v.calls(), 1, "never paid twice");
});

test("music (paid generative provider) gets the same transient-failure protection", async () => {
  const store = flakyStore({ putBytes: 1 });
  let calls = 0;
  const musicProvider = { name: "beatoven", async getTrack() { calls++; return { audioBuffer: audio, durationSeconds: 30, mimeType: "audio/mpeg", extension: "mp3" }; } };
  const deps = { ledger: memoryLedgerStore(), results: store, requestId: "req-2", musicProvider, estimatedCostUsd: 0.4, storageRetry: noWait } as never;
  await gatedMusicTrack(deps, { durationSeconds: 30 } as never);
  const again = await gatedMusicTrack(deps, { durationSeconds: 30 } as never);
  assert.equal(again.reused, true); assert.equal(calls, 1);
});
