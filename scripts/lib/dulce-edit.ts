/** Pure planning for the Dulce final edit: picture timeline, narration placement,
 * music sections and word-highlight subtitles. No I/O, so it is unit-tested and
 * the render is reproducible from the committed shot plan plus cached assets.
 */
export const FPS = 30;

export type WordTiming = { text: string; startSeconds: number; endSeconds: number };
export type PlanShot = {
  shotId: string; beatId: string; startFrame: number; endFrame: number; editFrames: number;
  newImageRequired: boolean; requestSeconds: number; animationRevision?: string;
  reuse?: { libraryFileName: string; inSeconds: number; outSeconds: number; storagePath?: string; sha256?: string } | null;
  existingStillPath?: string | null;
};
export type MeasuredBeat = { beatId: string; startFrame: number; endFrame: number; voiceOffsetSeconds: number; audioDurationSeconds: number };

/** Durable record key used by wrapDurableVideoProvider for a shot's current animation revision. */
export function clipRecordKey(shot: PlanShot): string {
  const rev = shot.animationRevision || 'v1';
  return rev === 'v1' ? shot.shotId : `${shot.shotId}-${rev}`;
}

/** Contiguous, gap-free picture timeline that exactly covers every measured beat. */
export function validateTimeline(shots: PlanShot[], beats: MeasuredBeat[]): { totalFrames: number } {
  let cursor = 0;
  for (const s of shots) {
    if (s.startFrame !== cursor) throw Error(`Timeline gap/overlap before ${s.shotId}: expected ${cursor}, got ${s.startFrame}`);
    if (s.endFrame - s.startFrame !== s.editFrames || s.editFrames <= 0) throw Error(`Invalid length ${s.shotId}`);
    cursor = s.endFrame;
  }
  for (const b of beats) {
    const inBeat = shots.filter(s => s.beatId === b.beatId);
    if (!inBeat.length || inBeat[0].startFrame !== b.startFrame || inBeat[inBeat.length - 1].endFrame !== b.endFrame) throw Error(`Beat ${b.beatId} not covered exactly by its shots`);
    if (b.voiceOffsetSeconds + b.audioDurationSeconds > (b.endFrame - b.startFrame) / FPS) throw Error(`Narration ${b.beatId} overruns its picture`);
  }
  if (beats[beats.length - 1].endFrame !== cursor) throw Error('Beats and shots disagree on total length');
  return { totalFrames: cursor };
}

/** In-point for a generated clip: skip the first frames (often near-static) when the clip is long enough. */
export function clipInPoint(clipSeconds: number, editSeconds: number, preferred = 0.25): number {
  const slack = clipSeconds - editSeconds - 0.05;
  return Math.max(0, Math.min(preferred, slack));
}

export type MusicSection = { trackId: string; startSeconds: number; endSeconds: number; fadeInSeconds: number; fadeOutSeconds: number };

/** Three licensed library cues across the four acts; overlaps give 2 s crossfades. */
export function musicSections(beats: MeasuredBeat[], tracks: [string, string, string]): MusicSection[] {
  const t = (f: number) => f / FPS;
  const byId = new Map(beats.map(b => [b.beatId, b]));
  const at = (id: string) => { const b = byId.get(id); if (!b) throw Error('Missing beat ' + id); return b; };
  const total = t(beats[beats.length - 1].endFrame);
  const cut1 = t(at('b5').startFrame), cut2 = t(at('b9').startFrame);
  return [
    { trackId: tracks[0], startSeconds: 0, endSeconds: cut1 + 1, fadeInSeconds: 0.3, fadeOutSeconds: 2 },
    { trackId: tracks[1], startSeconds: cut1 - 1, endSeconds: cut2 + 1, fadeInSeconds: 2, fadeOutSeconds: 2 },
    { trackId: tracks[2], startSeconds: cut2 - 1, endSeconds: total, fadeInSeconds: 2, fadeOutSeconds: 3 },
  ];
}

export type Cue = { start: number; end: number; words: WordTiming[] };

const clean = (w: string) => w.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();

/** Groups absolute-timed words into short readable cues: break on punctuation, pauses, and length. */
export function buildCues(words: WordTiming[], maxChars = 40, maxWords = 7): Cue[] {
  const cues: Cue[] = [];
  let cur: WordTiming[] = [];
  const flush = () => { if (cur.length) cues.push({ start: cur[0].startSeconds, end: cur[cur.length - 1].endSeconds, words: cur }); cur = []; };
  for (let i = 0; i < words.length; i++) {
    const w = { ...words[i], text: clean(words[i].text) };
    if (!w.text) continue;
    const prev = cur[cur.length - 1];
    const len = cur.map(x => x.text).join(' ').length + (cur.length ? 1 : 0) + w.text.length;
    if (prev && (len > maxChars || cur.length >= maxWords || w.startSeconds - prev.endSeconds > 0.45)) flush();
    cur.push(w);
    if (/[.!?;:—]["”']?$/.test(w.text) || (/,$/.test(w.text) && cur.length >= 3)) flush();
  }
  flush();
  // Hold each cue briefly after its last word, never into the next cue.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]?.start ?? Infinity;
    cues[i].end = next - cues[i].end < 0.6 ? next : Math.min(cues[i].end + 0.35, next);
  }
  return cues;
}

const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};

export type TitleOverlay = { start: number; end: number; lines: string[]; style: 'Title' | 'Note' };

/** ASS script: one event per spoken word, current word highlighted in amber (colour only, no motion). */
export function buildAss(cues: Cue[], overlays: TitleOverlay[]): string {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,DejaVu Sans,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,3,1.5,2,160,160,64,1
Style: Title,DejaVu Serif,104,&H00F2F2F2,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,14,0,1,2,3,5,100,100,0,1
Style: Note,DejaVu Sans,34,&H00D8D8D8,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,2,1.5,2,100,100,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines: string[] = [];
  for (const cue of cues) {
    cue.words.forEach((w, k) => {
      const start = k === 0 ? cue.start : w.startSeconds;
      const end = k === cue.words.length - 1 ? cue.end : cue.words[k + 1].startSeconds;
      if (end <= start) return;
      const text = cue.words.map((x, j) => (j === k ? `{\\c&H0048C8FF&}${x.text}{\\c&H00FFFFFF&}` : x.text)).join(' ');
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Sub,,0,0,0,,${text}`);
    });
  }
  for (const o of overlays) {
    // Title: first line large, following lines smaller with wide tracking.
    const text = o.style === 'Title' ? o.lines.map((l, i) => (i ? `{\\fs52\\fsp8}${clean(l)}` : clean(l))).join('\\N') : o.lines.map(clean).join('\\N');
    lines.push(`Dialogue: 1,${assTime(o.start)},${assTime(o.end)},${o.style},,0,0,0,,{\\fad(500,600)}${text}`);
  }
  return head + lines.join('\n') + '\n';
}

/** Longest continuous span of the picture without a cut (seconds). */
export function longestHold(shots: PlanShot[]): { shotId: string; seconds: number } {
  return shots.reduce((a, s) => (s.editFrames / FPS > a.seconds ? { shotId: s.shotId, seconds: s.editFrames / FPS } : a), { shotId: '', seconds: 0 });
}
