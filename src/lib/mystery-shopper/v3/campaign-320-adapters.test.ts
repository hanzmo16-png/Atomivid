import test from "node:test";
import assert from "node:assert/strict";
import { acceptRealReel, acceptRealVideoPodcast, campaign320SpendGate } from "./campaign-320-adapters";
import type { LedgerState } from "./ledger";

const empty: LedgerState = { reservations: [], settlements: [] };

test("issue #320: Reels y Podcast bloquean el clic sin interruptor, libro, monto o saldo", () => {
  const base = { real: true, killSwitch: true, stopped: false, ledger: empty, amountUsd: 1, runCapUsd: 3, runCommittedUsd: 0 };
  assert.equal(campaign320SpendGate("reels", { ...base, real: false }).ok, false);
  assert.equal(campaign320SpendGate("reels", { ...base, killSwitch: false }).ok, false);
  assert.equal(campaign320SpendGate("video-podcast", { ...base, stopped: true }).ok, false);
  assert.equal(campaign320SpendGate("video-podcast", { ...base, ledger: null }).ok, false);
  assert.equal(campaign320SpendGate("reels", { ...base, amountUsd: null }).ok, false);
  assert.equal(campaign320SpendGate("reels", { ...base, runCapUsd: 0.5 }).ok, false);
});

test("issue #320: la guardia respeta los topes acumulado y por módulo", () => {
  const base = { real: true, killSwitch: true, stopped: false, ledger: empty, runCapUsd: 3, runCommittedUsd: 0 };
  assert.equal(campaign320SpendGate("reels", { ...base, amountUsd: 1.5 }).ok, true);
  assert.equal(campaign320SpendGate("reels", { ...base, amountUsd: 1.51 }).ok, false);
  assert.equal(campaign320SpendGate("video-podcast", { ...base, amountUsd: 3 }).ok, true);
  assert.equal(campaign320SpendGate("video-podcast", { ...base, amountUsd: 3.01 }).ok, false);
});

test("issue #320: un Reel requiere 30 s, 9:16, audio y subtítulos medidos", () => {
  const good = { durationSeconds: 30, width: 1080, height: 1920, audioTracks: 1, decodeErrors: [], subtitlesMeasured: true, subtitlesPresent: true };
  assert.deepEqual(acceptRealReel(good), { ok: true, reasons: [] });
  const bad = acceptRealReel({ ...good, durationSeconds: 24, width: 1920, height: 1080, audioTracks: 0, subtitlesMeasured: false, subtitlesPresent: null });
  assert.equal(bad.ok, false);
  assert.match(bad.reasons.join(" "), /Duración|9:16|audio|Subtítulos/);
});

test("issue #320: Podcast audiovisual exige MP4 16:9, audio y sincronía medida", () => {
  const good = { durationSeconds: 180, width: 1920, height: 1080, audioTracks: 1, decodeErrors: [], lipSyncMeasured: true, lipSyncPass: true };
  assert.deepEqual(acceptRealVideoPodcast(good, 180), { ok: true, reasons: [] });
  const unknown = acceptRealVideoPodcast({ ...good, lipSyncMeasured: false, lipSyncPass: null }, 180);
  assert.equal(unknown.ok, false);
  assert.match(unknown.reasons.join(" "), /no se aprueba/i);
});
