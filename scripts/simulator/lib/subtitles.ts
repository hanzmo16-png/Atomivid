/**
 * Integridad de subtítulos contra las marcas temporales de la narración.
 *
 * Tolerancias explícitas (segundos). Se eligieron a partir de la resolución
 * temporal real del render (1 fotograma = 33 ms a 30 fps) y de cómo
 * buildCaptions() agrupa palabras (sus límites SON los de las palabras):
 */
export const SUBTITLE_TOLERANCES = {
  /** Solapamiento máximo admitido entre dos subtítulos consecutivos (< 1 fotograma). */
  overlapS: 0.02,
  /** Margen sobre el final del audio/video para el último subtítulo (≈ 1.5 fotogramas). */
  boundsS: 0.05,
  /** Desfase inicial / final máximo frente a la primera / última palabra narrada (3 fotogramas). */
  edgeOffsetS: 0.1,
  /** Desfase máximo de cualquier subtítulo frente a sus palabras (3 fotogramas). */
  maxDriftS: 0.1,
  /** Deriva acumulada máxima (último menos primer desfase): detecta corrimiento progresivo. */
  cumulativeDriftS: 0.05,
  /** Un subtítulo no debe seguir en pantalla más de esto dentro de un silencio narrativo. */
  pauseIntrusionS: 0.15,
} as const;

export type Cue = { text: string; startSeconds: number; endSeconds: number };
export type Word = { text: string; startSeconds: number; endSeconds: number };
export type Interval = { startSeconds: number; endSeconds: number };

export type SubtitleReport = {
  tolerances: typeof SUBTITLE_TOLERANCES;
  cueCount: number;
  wordCount: number;
  issues: { code: string; index?: number; detail: string }[];
  metrics: {
    initialOffsetS: number | null;
    finalOffsetS: number | null;
    maxAbsDriftS: number | null;
    cumulativeDriftS: number | null;
    maxOverlapS: number;
    silencesChecked: number;
    silencesWithoutSubtitle: number;
    pauseIntrusions: number;
    textMatchesNarration: boolean;
  };
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function analyzeSubtitles(input: {
  cues: Cue[];
  words: Word[];
  audioDurationSeconds: number;
  videoDurationSeconds: number;
  /** Silencios narrativos (huecos entre palabras o silencios medidos en el audio). */
  silences: Interval[];
}): SubtitleReport {
  const t = SUBTITLE_TOLERANCES;
  const { cues, words } = input;
  const issues: SubtitleReport["issues"] = [];
  let maxOverlap = 0;
  cues.forEach((c, i) => {
    if (!(c.endSeconds > c.startSeconds)) issues.push({ code: "non_positive_duration", index: i, detail: `${c.startSeconds}→${c.endSeconds}` });
    if (c.startSeconds < -1e-3) issues.push({ code: "before_zero", index: i, detail: String(c.startSeconds) });
    if (c.endSeconds > input.audioDurationSeconds + t.boundsS) issues.push({ code: "beyond_audio", index: i, detail: `${c.endSeconds} > audio ${input.audioDurationSeconds}` });
    if (c.endSeconds > input.videoDurationSeconds + t.boundsS) issues.push({ code: "beyond_video", index: i, detail: `${c.endSeconds} > video ${input.videoDurationSeconds}` });
    if (i > 0) {
      const prev = cues[i - 1];
      if (c.startSeconds < prev.startSeconds) issues.push({ code: "out_of_order", index: i, detail: `${c.startSeconds} < ${prev.startSeconds}` });
      const overlap = prev.endSeconds - c.startSeconds;
      maxOverlap = Math.max(maxOverlap, overlap);
      if (overlap > t.overlapS) issues.push({ code: "overlap", index: i, detail: `${overlap.toFixed(3)}s` });
    }
  });

  // Alinear cada subtítulo con su tramo de palabras (por texto, en orden).
  const drifts: number[] = [];
  let w = 0;
  let textOk = true;
  for (let i = 0; i < cues.length; i++) {
    const tokens = norm(cues[i].text).split(" ");
    const first = w;
    for (const tok of tokens) {
      if (w >= words.length || norm(words[w].text) !== tok) { textOk = false; break; }
      w++;
    }
    if (!textOk) { issues.push({ code: "text_mismatch", index: i, detail: `"${cues[i].text}" no coincide con la narración en la palabra ${w}` }); break; }
    const startDrift = cues[i].startSeconds - words[first].startSeconds;
    const endDrift = cues[i].endSeconds - words[w - 1].endSeconds;
    drifts.push(startDrift, endDrift);
    if (Math.abs(startDrift) > t.maxDriftS || Math.abs(endDrift) > t.maxDriftS) issues.push({ code: "drift", index: i, detail: `inicio ${startDrift.toFixed(3)}s, fin ${endDrift.toFixed(3)}s` });
  }
  if (textOk && w !== words.length) { textOk = false; issues.push({ code: "words_without_subtitle", detail: `${words.length - w} palabras narradas sin subtítulo` }); }

  const initialOffset = cues.length && words.length ? cues[0].startSeconds - words[0].startSeconds : null;
  const finalOffset = cues.length && words.length ? cues[cues.length - 1].endSeconds - words[words.length - 1].endSeconds : null;
  if (initialOffset !== null && Math.abs(initialOffset) > t.edgeOffsetS) issues.push({ code: "initial_offset", detail: `${initialOffset.toFixed(3)}s` });
  if (finalOffset !== null && Math.abs(finalOffset) > t.edgeOffsetS) issues.push({ code: "final_offset", detail: `${finalOffset.toFixed(3)}s` });
  const cumulative = drifts.length >= 2 ? drifts[drifts.length - 1] - drifts[0] : null;
  if (cumulative !== null && Math.abs(cumulative) > t.cumulativeDriftS) issues.push({ code: "cumulative_drift", detail: `${cumulative.toFixed(3)}s` });

  // Silencios: no se exige subtítulo durante una pausa; sí se señala uno que se queda en pantalla dentro de ella.
  let without = 0;
  let intrusions = 0;
  for (const s of input.silences) {
    const covering = cues.filter((c) => c.startSeconds < s.endSeconds && c.endSeconds > s.startSeconds);
    if (covering.length === 0) without++;
    for (const c of covering) {
      const inside = Math.min(c.endSeconds, s.endSeconds) - Math.max(c.startSeconds, s.startSeconds);
      if (inside > t.pauseIntrusionS) { intrusions++; issues.push({ code: "subtitle_during_silence", detail: `"${c.text.slice(0, 40)}" ${inside.toFixed(2)}s dentro del silencio ${s.startSeconds.toFixed(2)}-${s.endSeconds.toFixed(2)}` }); }
    }
  }

  return {
    tolerances: t,
    cueCount: cues.length,
    wordCount: words.length,
    issues,
    metrics: {
      initialOffsetS: initialOffset,
      finalOffsetS: finalOffset,
      maxAbsDriftS: drifts.length ? Math.max(...drifts.map(Math.abs)) : null,
      cumulativeDriftS: cumulative,
      maxOverlapS: maxOverlap,
      silencesChecked: input.silences.length,
      silencesWithoutSubtitle: without,
      pauseIntrusions: intrusions,
      textMatchesNarration: textOk,
    },
  };
}

/** Silencios reales del archivo de audio (ffmpeg silencedetect, -45 dB, ≥ minS). */
export function parseSilencedetect(stderr: string): Interval[] {
  const out: Interval[] = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end: ([\d.]+)/);
    if (e && start !== null) { out.push({ startSeconds: start, endSeconds: Number(e[1]) }); start = null; }
  }
  return out;
}
