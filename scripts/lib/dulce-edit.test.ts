import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAss, buildCues, clipInPoint, clipRecordKey, longestHold, musicSections, validateTimeline, FPS } from './dulce-edit';

const spec = JSON.parse(fs.readFileSync('content/long-form/dulce-001/full-shots.json', 'utf8'));

test('committed Dulce plan is a gap-free 73-shot timeline with narration inside every beat', () => {
  const { totalFrames } = validateTimeline(spec.shots, spec.measuredBeats);
  assert.equal(spec.shots.length, 73);
  assert.equal(totalFrames / FPS, 570);
  assert.ok(longestHold(spec.shots).seconds <= 9.5, 'no single picture holds longer than a clip');
});

test('every animated shot maps to its current durable revision key', () => {
  const animated = spec.shots.filter((s: { reuse: unknown }) => !s.reuse);
  assert.equal(animated.length, 72);
  assert.equal(clipRecordKey(spec.shots.find((s: { shotId: string }) => s.shotId === 'D02-03')), 'D02-03-v3');
  assert.equal(clipRecordKey(spec.shots.find((s: { shotId: string }) => s.shotId === 'D03-01')), 'D03-01');
});

test('in-point never exceeds the clip slack', () => {
  assert.equal(clipInPoint(10, 9.17), 0.25);
  assert.ok(Math.abs(clipInPoint(9.3, 9.17) - 0.08) < 1e-9);
  assert.equal(clipInPoint(9.1, 9.17), 0);
});

test('music sections cover the episode with crossfade overlaps', () => {
  const m = musicSections(spec.measuredBeats, ['a', 'b', 'c']);
  assert.equal(m[0].startSeconds, 0);
  assert.equal(m[2].endSeconds, 570);
  assert.ok(m[1].startSeconds < m[0].endSeconds && m[2].startSeconds < m[1].endSeconds);
});

test('cues break on punctuation and length, never overlap, and highlight each word once', () => {
  const words = 'The corridor was supposed to end at a locked door. In this fictional retelling, it did not.'.split(' ')
    .map((text, i) => ({ text, startSeconds: i * 0.4, endSeconds: i * 0.4 + 0.3 }));
  const cues = buildCues(words);
  assert.ok(cues.some(c => c.words.at(-1)!.text === 'door.'), 'a sentence end closes its cue');
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i - 1].end <= cues[i].start);
  for (const c of cues) assert.ok(c.words.map(w => w.text).join(' ').length <= 40);
  const ass = buildAss(cues, [{ start: 1, end: 3, lines: ['DULCE'], style: 'Title' }]);
  assert.equal((ass.match(/Style: Sub/g) || []).length, 1);
  assert.equal((ass.match(/Dialogue: 0,/g) || []).length, words.length);
  assert.match(ass, /Dialogue: 1,0:00:01\.00,0:00:03\.00,Title/);
});
