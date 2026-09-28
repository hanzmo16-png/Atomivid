import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canSpend, conformTimeline, exposureUsd, moveFor, scriptWordsWithTimings, stillMotionFilter, v1InPoint, FPS, type LedgerEntry, type Slot } from './dulce-part1-core';

test('hard cap counts committed actuals and open reservations at their maximum', () => {
  const l: LedgerEntry[] = [
    { key: 'creator', kind: 'subscription', maxUsd: 11, actualUsd: null, status: 'reserved' },
    { key: 'image-N01', kind: 'image', maxUsd: 0.3, actualUsd: 0.09, status: 'committed' },
    { key: 'video-N11', kind: 'video', maxUsd: 0.25, actualUsd: null, status: 'released' },
  ];
  assert.ok(Math.abs(exposureUsd(l) - 11.09) < 1e-9);
  assert.equal(canSpend(l, 28.91).ok, true);
  assert.equal(canSpend(l, 28.92).ok, false);
  assert.equal(canSpend(l, Number.NaN).ok, false);
});

const slots: Slot[] = [
  { id: 'a', beat: 'p01', src: 'N01', sec: 3, productionMethod: 'ken_burns', shotClass: 'landscape' },
  { id: 'b', beat: 'p01', src: 'N02', sec: 1, productionMethod: 'ken_burns', shotClass: 'landscape' },
  { id: 'c', beat: 'end', src: 'G7', sec: 6, productionMethod: 'graphic', shotClass: 'graphic' },
];
test('conform scales slots to measured narration and stays frame-exact and gap-free', () => {
  const t = conformTimeline(slots, [{ beatId: 'p01', audioSeconds: 10.1 }]);
  const p01 = Math.round((0.4 + 10.1 + 1.5) * FPS);
  assert.equal(t.slots[0].frames + t.slots[1].frames, p01);
  assert.equal(t.slots[1].startFrame, t.slots[0].frames);
  assert.equal(t.totalFrames, p01 + 6 * FPS);
  assert.throws(() => conformTimeline(slots, []), /No measured narration/);
});

test('every committed storyboard slot survives a realistic conform', () => {
  const sb = JSON.parse(fs.readFileSync('content/long-form/dulce-part1/storyboard.json', 'utf8'));
  const beats = Object.entries(sb.beatSeconds as Record<string, number>).filter(([k]) => k !== 'end').map(([beatId, s]) => ({ beatId, audioSeconds: s - 1.5 }));
  const t = conformTimeline(sb.shots, beats);
  assert.equal(t.slots.length, sb.shots.length);
  assert.ok(t.totalFrames / FPS > 480 && t.totalFrames / FPS < 560);
});

test('still-motion filters stay inside the headroom and vary by slot', () => {
  for (const m of ['push-in', 'pull-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down'] as const) {
    const f = stillMotionFilter(m, 150);
    assert.match(f, /^scale=(2304:1296|1920:1080)/);
    assert.ok(f.includes('1920'));
  }
  assert.notEqual(moveFor(0, 'landscape'), moveFor(2, 'landscape'));
  assert.equal(moveFor(0, 'single_human'), 'push-in');
});

test('subtitles use script words with alignment timings, never TTS aliases', () => {
  const w = scriptWordsWithTimings('Near Dulce, New Mexico.', [
    { text: 'Near', startSeconds: 0, endSeconds: 0.2 }, { text: 'Dool-say,', startSeconds: 0.25, endSeconds: 0.7 },
    { text: 'New', startSeconds: 0.8, endSeconds: 0.9 }, { text: 'Mexico.', startSeconds: 0.95, endSeconds: 1.4 }]);
  assert.equal(w[1].text, 'Dulce,');
  assert.equal(w[1].startSeconds, 0.25);
  assert.throws(() => scriptWordsWithTimings('a b', [{ text: 'a', startSeconds: 0, endSeconds: 1 }]), /Alignment/);
});

test('V1 in-points stay inside the clean window and repeats use a later window', () => {
  assert.equal(v1InPoint(10.08, 3.0, 2.5, 0), 0.25);
  assert.ok(Math.abs(v1InPoint(10.08, 3.0, 2.8, 0) - 0.2) < 1e-9);
  assert.ok(v1InPoint(10.08, null, 3, 1) > 5);
  assert.equal(v1InPoint(10.08, 3.0, 2.5, 1), 0.25);
});
