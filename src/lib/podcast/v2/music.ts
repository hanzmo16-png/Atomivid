/** Podcast 2.0 — Director musical: cues por emoción, sin cambios bruscos ni constantes; ducking y loudness. */
import type { DirectionPlan } from "./director";

export type MusicTrack = { file: string; title: string; artist: string; license: "CC BY 4.0"; source_url: string; moods: string[] };
export type MusicCue = { start_ms: number; end_ms: number; track: string | null; mood: string; bed_db: number; fade_in_ms: number; fade_out_ms: number };

export const LOUDNESS = { integrated_lufs: -16, tolerance: 2, true_peak_max_db: -1, ducking_db: -12 } as const;
const MIN_CUE_MS = 45_000; // no cambiar de cue antes de 45 s (evita cambios constantes)

export function planMusic(plan: DirectionPlan, library: MusicTrack[]): MusicCue[] {
  const cues: MusicCue[] = [];
  let t = 0;
  for (const s of plan.segments) {
    const dur = (s.actual_duration_ms ?? s.estimated_duration_ms);
    const mood = s.music_cue.mood;
    const last = cues[cues.length - 1];
    const canSwitch = !last || last.end_ms - last.start_ms >= MIN_CUE_MS || s.music_cue.silence_before;
    if (last && (last.mood === mood || !canSwitch)) last.end_ms = t + dur;
    else {
      if (last && s.music_cue.silence_before) last.end_ms = Math.max(last.start_ms + 1000, t - 600); // silencio intencional
      const track = mood === "none" ? null : (library.find(l => l.moods.includes(mood)) ?? library[0] ?? null);
      cues.push({ start_ms: t, end_ms: t + dur, track: track?.file ?? null, mood, bed_db: mood === "reflection" ? -30 : -24, fade_in_ms: 1500, fade_out_ms: 2000 });
    }
    t += dur;
  }
  return cues;
}

export function musicIssues(cues: MusicCue[], licensed: Set<string>): string[] {
  const out: string[] = [];
  cues.forEach((c, i) => {
    if (c.track && !licensed.has(c.track)) out.push(`cue ${i}: pista sin licencia verificable (${c.track})`);
    if (c.bed_db > -18) out.push(`cue ${i}: música demasiado alta (${c.bed_db} dB)`);
    if (i > 0 && c.end_ms - c.start_ms < 8000 && c.track) out.push(`cue ${i}: cambio demasiado breve`);
  });
  return out;
}
