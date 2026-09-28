/** Pure planning for Dulce Part I: hard budget gate, timeline conform, still-motion filters,
 * subtitle words from the master script. No I/O; unit-tested in dulce-part1-core.test.ts.
 */
export const FPS = 30;
export const HARD_CAP_USD = 40;

export type LedgerEntry = { key: string; kind: string; maxUsd: number; actualUsd: number | null; status: 'reserved' | 'committed' | 'released' };

/** Spend that counts against the cap: committed at actual cost, open reservations at their maximum. */
export function exposureUsd(entries: LedgerEntry[]): number {
  return entries.reduce((a, e) => a + (e.status === 'committed' ? (e.actualUsd ?? e.maxUsd) : e.status === 'reserved' ? e.maxUsd : 0), 0);
}
/** Checked BEFORE every paid call: current exposure + the operation's maximum possible cost must fit the cap. */
export function canSpend(entries: LedgerEntry[], maxUsd: number, cap = HARD_CAP_USD): { ok: boolean; exposure: number; after: number } {
  const exposure = exposureUsd(entries);
  const after = exposure + maxUsd;
  return { ok: Number.isFinite(maxUsd) && maxUsd >= 0 && after <= cap + 1e-9, exposure, after };
}

export type Slot = { id: string; beat: string; src: string; sec: number; productionMethod: string; shotClass: string; reuse?: boolean };
export type MeasuredBeat = { beatId: string; audioSeconds: number };
export type TimedSlot = Slot & { startFrame: number; frames: number };
export const BEAT_TAIL = 1.5;
export const LEAD_IN = 0.4;

/** Scales each beat's planned slots to its measured narration (+ lead-in and tail); frame-exact, gap-free. */
export function conformTimeline(slots: Slot[], beats: MeasuredBeat[], endCardSeconds = 6): { slots: TimedSlot[]; beatStarts: Record<string, number>; totalFrames: number } {
  const out: TimedSlot[] = [];
  const beatStarts: Record<string, number> = {};
  let cursor = 0;
  const order = [...new Set(slots.map(s => s.beat))];
  for (const beat of order) {
    const inBeat = slots.filter(s => s.beat === beat);
    const measured = beats.find(b => b.beatId === beat);
    const targetFrames = Math.round((beat === 'end' ? endCardSeconds : LEAD_IN + (measured?.audioSeconds ?? NaN) + BEAT_TAIL) * FPS);
    if (!Number.isFinite(targetFrames)) throw Error('No measured narration for beat ' + beat);
    const planned = inBeat.reduce((a, s) => a + s.sec, 0);
    beatStarts[beat] = cursor;
    let used = 0;
    inBeat.forEach((s, i) => {
      const frames = i === inBeat.length - 1 ? targetFrames - used : Math.max(Math.round(1.0 * FPS), Math.round((s.sec / planned) * targetFrames));
      if (frames < FPS) throw Error(`Slot ${s.id} would last under 1 s`);
      out.push({ ...s, startFrame: cursor + used, frames });
      used += frames;
    });
    cursor += used;
  }
  return { slots: out, beatStarts, totalFrames: cursor };
}

export type Move = 'push-in' | 'pull-out' | 'pan-left' | 'pan-right' | 'tilt-up' | 'tilt-down';
/** Deterministic, varied camera move per slot; portraits get gentle push-ins, landscapes pans. */
export function moveFor(index: number, shotClass: string): Move {
  const portrait = ['single_human', 'creature'].includes(shotClass);
  const wide = ['landscape', 'corridor'].includes(shotClass);
  const cycle: Move[] = portrait ? ['push-in', 'push-in', 'pull-out', 'tilt-down'] : wide ? ['pan-right', 'push-in', 'pan-left', 'tilt-up'] : ['push-in', 'pan-left', 'pull-out', 'pan-right', 'tilt-down'];
  return cycle[index % cycle.length];
}

/** FFmpeg filter that turns a still (any size) into `frames` of 1920x1080/30 controlled camera motion.
 * The still is first cover-scaled to 2304x1296 (20% headroom) so every move stays inside the image. */
export function stillMotionFilter(move: Move, frames: number): string {
  const W = 2304, H = 1296, w = 1920, h = 1080, n = Math.max(1, frames - 1);
  // zoompan counts output frames as `on`; crop counts input frames as `n`.
  const ease = (v: string) => `(0.5-0.5*cos(PI*(${v}/${n})))`;
  const base = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`;
  switch (move) {
    case 'push-in': case 'pull-out': {
      // Per-frame resample (sub-pixel smooth) instead of zoompan, which snaps to whole pixels and jitters.
      const z = move === 'push-in' ? `(1+0.12*${ease('n')})` : `(1.12-0.12*${ease('n')})`;
      return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},scale=w='trunc(${w}*${z}/2)*2':h='trunc(${h}*${z}/2)*2':eval=frame:flags=bicubic,crop=${w}:${h}`;
    }
    case 'pan-left': case 'pan-right': {
      const x = move === 'pan-right' ? `(${W - w})*${ease('n')}` : `(${W - w})*(1-${ease('n')})`;
      return `${base},crop=${w}:${h}:x='${x}':y=${(H - h) / 2}`;
    }
    case 'tilt-up': case 'tilt-down': {
      const y = move === 'tilt-down' ? `(${H - h})*${ease('n')}` : `(${H - h})*(1-${ease('n')})`;
      return `${base},crop=${w}:${h}:x=${(W - w) / 2}:y='${y}'`;
    }
  }
}

export type WordTiming = { text: string; startSeconds: number; endSeconds: number };
/** Subtitle words come from the approved script, timings from the TTS alignment (aliases never shown).
 * Requires the same word count: every alias in the pronunciation dictionary is a single token. */
export function scriptWordsWithTimings(scriptText: string, aligned: WordTiming[]): WordTiming[] {
  const words = scriptText.split(/\s+/).filter(Boolean);
  if (words.length !== aligned.length) throw Error(`Alignment has ${aligned.length} words, script has ${words.length}`);
  return words.map((text, i) => ({ text, startSeconds: aligned[i].startSeconds, endSeconds: aligned[i].endSeconds }));
}

/** Where to cut a V1 clip: stay inside its clean window, and use a later window for a repeat when possible. */
export function v1InPoint(clipSeconds: number, usableUntil: number | null, editSeconds: number, useIndex: number): number {
  const end = Math.min(clipSeconds - 0.05, usableUntil ?? clipSeconds - 0.05);
  const first = Math.min(0.25, Math.max(0, end - editSeconds));
  if (useIndex === 0) return first;
  const late = end - editSeconds;
  return late > first + 1.0 ? late : first;
}
