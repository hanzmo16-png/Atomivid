/**
 * hans-01 final edit (USD 0): the existing 38.8 s animatic (Grok, Drive 10U-YfilHJHD…, sha256 c88a3368…) retimed to the
 * REAL narration, with the two avatar clips in the «AVATAR PENDIENTE» slots and subtitles from the real word timings.
 *
 * - Timeline comes from word timestamps of the single master narration; the avatar clips were cut from that same audio,
 *   so the master voice is the only speech track (lip-sync preserved, no second voice).
 * - Animatic scenes keep their honesty labels («Demostración ilustrativa», «Material de prueba», «Resultados de pruebas»);
 *   the «ANIMATIC · SIN VOZ» tag and the estimated-time subtitles baked into the animatic are blurred out and replaced.
 * - Scenes are retimed (setpts), never the voice. Hard cuts at word boundaries.
 */
export type Word = { text: string; startSeconds: number; endSeconds: number };
export type Seg = { kind: "avatar"; clip: "apertura" | "cierre"; start: number; end: number }
  | { kind: "animatic"; srcStart: number; srcEnd: number; start: number; end: number };

/** Animatic windows (source seconds), from the delivered EDL and its frames: crossfade frames excluded. */
export const ANIMATIC = { s2: [5.0, 18.4], s3: [18.7, 27.1], s5: [33.1, 38.8], seconds: 38.8 } as const;
export const W = 720, H = 1280;
const PAD = 0.2, TAIL = 1.5;

const find = (w: Word[], pred: (x: Word) => boolean, what: string) => {
  const i = w.findIndex(pred);
  if (i < 0) throw new Error(`compose_word_not_found:${what}`);
  return i;
};

/** Same cut rule as generate (scripts/precampaign-hans01/run.ts), so segment edges match the clips' audio exactly. */
export function avatarCuts(w: Word[]) {
  const iOpenEnd = find(w, x => x.text.endsWith("tiempo?"), "tiempo?");
  const iCloseStart = find(w, x => x.text === "¿Quieres", "¿Quieres"), iCloseEnd = find(w, x => x.text === "Síguenos.", "Síguenos.");
  return {
    apertura: { start: 0, end: Math.min(w[iOpenEnd].endSeconds + PAD, w[iOpenEnd + 1].startSeconds - 0.02) },
    cierre: { start: Math.max(w[iCloseStart].startSeconds - PAD, w[iCloseStart - 1].endSeconds + 0.02), end: Math.min(w[iCloseEnd].endSeconds + PAD, w[iCloseEnd + 1].startSeconds - 0.02) },
  };
}

export function planCompose(w: Word[], voiceSeconds: number, clipSeconds?: { apertura: number; cierre: number }): { segs: Seg[]; total: number } {
  if (!w.length || !(voiceSeconds > 0)) throw new Error("compose_no_narration");
  const cuts = avatarCuts(w);
  const tA = clipSeconds ? Math.min(clipSeconds.apertura, cuts.apertura.end) : cuts.apertura.end;
  const tMira = w[find(w, x => x.text === "Mira", "Mira")].startSeconds;
  const tCs = cuts.cierre.start, tCe = clipSeconds ? Math.min(tCs + clipSeconds.cierre, cuts.cierre.end) : cuts.cierre.end;
  const total = Math.round((voiceSeconds + TAIL) * 1000) / 1000;
  const segs: Seg[] = [
    { kind: "avatar", clip: "apertura", start: 0, end: tA },
    { kind: "animatic", srcStart: ANIMATIC.s2[0], srcEnd: ANIMATIC.s2[1], start: tA, end: tMira },
    { kind: "animatic", srcStart: ANIMATIC.s3[0], srcEnd: ANIMATIC.s3[1], start: tMira, end: tCs },
    { kind: "avatar", clip: "cierre", start: tCs, end: tCe },
    { kind: "animatic", srcStart: ANIMATIC.s5[0], srcEnd: ANIMATIC.s5[1], start: tCe, end: total },
  ];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!(s.end - s.start > 0.3)) throw new Error(`compose_segment_too_short:${i}`);
    if (i && Math.abs(s.start - segs[i - 1].end) > 1e-6) throw new Error(`compose_gap:${i}`);
  }
  return { segs, total };
}

/** Break a cue into two balanced lines at the space nearest the middle (ASS hard break). */
export function twoLines(text: string, maxLine = 26) {
  if (text.length <= maxLine) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? text : `${text.slice(0, best)}\\N${text.slice(best + 1)}`;
}

/** Subtitle cues from the real word timings: break at sentence end or when a cue would exceed maxChars (2 lines). */
export function subtitleLines(w: Word[], maxChars = 46) {
  const lines: { text: string; start: number; end: number }[] = [];
  let cur: Word[] = [];
  const flush = () => { if (cur.length) lines.push({ text: cur.map(x => x.text).join(" "), start: cur[0].startSeconds, end: cur[cur.length - 1].endSeconds }); cur = []; };
  for (const x of w) {
    if (cur.length && cur.map(y => y.text).join(" ").length + 1 + x.text.length > maxChars) flush();
    cur.push(x);
    if (/[.?!]$/.test(x.text)) flush();
  }
  flush();
  // Hold each line until the next starts (max +0.6 s), so short pauses do not flash.
  for (let i = 0; i < lines.length; i++) lines[i].end = Math.min(i + 1 < lines.length ? lines[i + 1].start : lines[i].end + 0.6, lines[i].end + 0.6);
  return lines;
}

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
};

/** Two-line max, white DejaVu Sans Bold on a 55 % black box, bottom band (where the animatic's own subtitles were). */
export function buildAss(w: Word[]) {
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n[V4+ Styles]\n` +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    "Style: Sub,DejaVu Sans,34,&H00FFFFFF,&H00FFFFFF,&H73000000,&H73000000,-1,0,0,0,100,100,0,0,3,10,0,2,60,60,110,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  return head + subtitleLines(w).map(l => `Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Sub,,0,0,0,,${twoLines(l.text.replace(/[{}\\]/g, ""))}`).join("\n") + "\n";
}

/** ffmpeg arguments. Inputs: 0 animatic, 1 voice wav, 2 clip apertura, 3 clip cierre. */
export function ffmpegArgs(p: { animatic: string; voice: string; apertura: string; cierre: string; ass: string; out: string }, plan: ReturnType<typeof planCompose>) {
  const f: string[] = [];
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,format=yuv420p`;
  // Blur the animatic's «ANIMATIC · SIN VOZ» tag and its estimated-time subtitle band.
  const clean = (i: number) => `split=3[b${i}][t${i}][s${i}];[t${i}]crop=440:64:140:16,boxblur=luma_radius=14:luma_power=4:chroma_radius=8:chroma_power=4[tb${i}];[s${i}]crop=${W}:190:0:1045,boxblur=luma_radius=30:luma_power=3:chroma_radius=20:chroma_power=3[sb${i}];` +
    `[b${i}][tb${i}]overlay=140:16[o${i}];[o${i}][sb${i}]overlay=0:1045`;
  plan.segs.forEach((s, i) => {
    const d = (s.end - s.start).toFixed(4);
    if (s.kind === "avatar") {
      const input = s.clip === "apertura" ? 2 : 3;
      f.push(`[${input}:v]${fit},trim=duration=${d},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=1,trim=duration=${d}[v${i}]`);
    } else {
      const factor = ((s.end - s.start) / (s.srcEnd - s.srcStart)).toFixed(6);
      f.push(`[0:v]trim=start=${s.srcStart}:end=${s.srcEnd},setpts=(PTS-STARTPTS)*${factor},${fit},tpad=stop_mode=clone:stop_duration=1,trim=duration=${d},${clean(i)}[v${i}]`);
    }
  });
  f.push(`${plan.segs.map((_, i) => `[v${i}]`).join("")}concat=n=${plan.segs.length}:v=1:a=0[vcat]`);
  f.push(`[vcat]subtitles=${p.ass}:fontsdir=/usr/share/fonts/truetype/dejavu[vout]`);
  // Master voice + the animatic's CC BY music, lowered under the voice and faded out at the end.
  const T = plan.total.toFixed(3);
  f.push(`[1:a]aresample=48000,apad,atrim=duration=${T}[vo]`);
  f.push(`[0:a]aresample=48000,volume=0.35,apad,atrim=duration=${T},afade=t=out:st=${(plan.total - 1.5).toFixed(3)}:d=1.5[mu]`);
  f.push(`[vo][mu]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]`);
  return ["-y", "-v", "error", "-i", p.animatic, "-i", p.voice, "-i", p.apertura, "-i", p.cierre, "-filter_complex", f.join(";"),
    "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-t", T, p.out];
}
