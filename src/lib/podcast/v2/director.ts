/**
 * Podcast 2.0 — Director emocional de voz (v1). Plan de dirección por segmento, validado con zod y
 * asignado de forma DETERMINISTA a partir del texto (sin aleatoriedad). No llama a ningún proveedor.
 * Capacidades de modelos: https://elevenlabs.io/docs/best-practices/prompting/controls (consultado 2026-10-21).
 */
import { z } from "zod";

export const DIRECTION_SCHEMA_VERSION = "podcast-voice-direction/1" as const;

export const EMOTIONS = ["calm_explanation", "everyday_conversation", "intrigue", "suspense", "revelation", "enthusiasm",
  "urgency", "reflection", "solemnity", "humor_surprise", "qa", "transition"] as const;
export type Emotion = typeof EMOTIONS[number];

export const SegmentDirection = z.object({
  segment_id: z.string().min(1),
  speaker_id: z.string().min(1),
  text: z.string().min(1),
  emotion: z.enum(EMOTIONS),
  delivery: z.string().min(1),
  pace: z.number().min(0.7).max(1.2),           // speed nativo ElevenLabs: 0.7–1.2
  intensity: z.number().min(0).max(1),
  emphasis: z.array(z.string()),
  pause_before_ms: z.number().int().min(0).max(3000),
  pause_after_ms: z.number().int().min(0).max(3000),
  pronunciation: z.array(z.object({ grapheme: z.string(), alias: z.string() })),
  voice_id: z.string().min(1),
  provider: z.enum(["elevenlabs", "own_recording", "mock"]),
  model: z.string().min(1),
  estimated_duration_ms: z.number().int().positive(),
  actual_duration_ms: z.number().int().positive().nullable(),
  music_cue: z.object({ mood: z.enum(["none", "calm", "suspense", "revelation", "reflection", "enthusiasm"]), level_db: z.number().max(0), silence_before: z.boolean() }),
  native: z.object({ stability: z.number().min(0).max(1), similarity_boost: z.number().min(0).max(1), style: z.number().min(0).max(1), speed: z.number().min(0.7).max(1.2), use_break_tags: z.boolean(), audio_tags: z.array(z.string()) }),
  post: z.object({ insert_silence_ms: z.number().int().min(0), crossfade_ms: z.number().int().min(0).max(200), loudness_target_lufs: z.number() }),
  adaptations: z.array(z.string()),
});
export const DirectionPlan = z.object({ version: z.literal(DIRECTION_SCHEMA_VERSION), segments: z.array(SegmentDirection).min(1) });
export type SegmentDirection = z.infer<typeof SegmentDirection>;
export type DirectionPlan = z.infer<typeof DirectionPlan>;

/** Capacidades REALES documentadas. «unverified» = no se envía. */
export const MODEL_CAPS: Record<string, { breakTags: boolean; audioTags: boolean; phonemeTags: boolean; contextText: boolean; speed: boolean; style: boolean; maxBreakMs: number }> = {
  eleven_multilingual_v2: { breakTags: true, audioTags: false, phonemeTags: false, contextText: true, speed: true, style: true, maxBreakMs: 3000 },
  eleven_flash_v2_5: { breakTags: true, audioTags: false, phonemeTags: false, contextText: true, speed: true, style: false, maxBreakMs: 3000 },
  eleven_flash_v2: { breakTags: true, audioTags: false, phonemeTags: true, contextText: true, speed: true, style: false, maxBreakMs: 3000 },
  eleven_v3: { breakTags: false, audioTags: true, phonemeTags: false, contextText: false, speed: true, style: false, maxBreakMs: 0 },
  eleven_v4: { breakTags: false, audioTags: true, phonemeTags: false, contextText: false, speed: true, style: false, maxBreakMs: 0 },
};

export class UnsupportedDirectionError extends Error {
  constructor(readonly model: string, readonly feature: string) { super(`El modelo ${model} no admite «${feature}»; no se envía nada al proveedor.`); }
}

const RULES: [Emotion, RegExp][] = [
  ["qa", /\?\s*$/],
  ["urgency", /\b(ahora mismo|urgente|ya no hay tiempo|inmediatamente|cuanto antes)\b/i],
  ["revelation", /\b(resulta que|la verdad es|descubri[óo]|en realidad|lo que nadie sab[ií]a)\b/i],
  ["suspense", /\b(de repente|nadie|silencio|oscur|desaparec|sin rastro|esa noche)\b/i],
  ["solemnity", /\b(muri[óo]|muerte|v[ií]ctimas|tragedia|luto|perdi[óo] la vida)\b/i],
  ["humor_surprise", /\b(jaja|incre[ií]ble|no me digas|en serio|qu[ée] locura)\b/i],
  ["enthusiasm", /!|\b(fant[áa]stic|impresionante|genial|me encanta)\b/i],
  ["reflection", /\b(quiz[áa]s|tal vez|me pregunto|pensemos|en el fondo|al final)\b/i],
  ["intrigue", /\b(misterio|extra[ñn]o|curioso|enigma|por qu[ée])\b/i],
  ["transition", /^(ahora bien|pasemos|vamos a|cambiando de tema|y ahora)\b/i],
  ["everyday_conversation", /\b(oye|mira|f[íi]jate|t[úu] sabes|claro)\b/i],
];

export function classifyEmotion(text: string): Emotion {
  for (const [e, re] of RULES) if (re.test(text.trim())) return e;
  return "calm_explanation";
}

const PROFILE: Record<Emotion, { delivery: string; pace: number; intensity: number; stability: number; style: number; pb: number; pa: number; mood: SegmentDirection["music_cue"]["mood"]; tag: string | null }> = {
  calm_explanation: { delivery: "explicativa, cálida", pace: 1.0, intensity: 0.35, stability: 0.6, style: 0.15, pb: 150, pa: 300, mood: "calm", tag: null },
  everyday_conversation: { delivery: "cercana, casual", pace: 1.03, intensity: 0.4, stability: 0.5, style: 0.25, pb: 100, pa: 250, mood: "calm", tag: null },
  intrigue: { delivery: "baja, pausada", pace: 0.95, intensity: 0.5, stability: 0.55, style: 0.3, pb: 250, pa: 400, mood: "suspense", tag: "[curious]" },
  suspense: { delivery: "contenida, tensa", pace: 0.9, intensity: 0.6, stability: 0.55, style: 0.35, pb: 400, pa: 600, mood: "suspense", tag: "[whispers]" },
  revelation: { delivery: "firme, con peso", pace: 0.92, intensity: 0.75, stability: 0.5, style: 0.4, pb: 700, pa: 500, mood: "revelation", tag: "[dramatically]" },
  enthusiasm: { delivery: "enérgica", pace: 1.08, intensity: 0.7, stability: 0.45, style: 0.4, pb: 100, pa: 250, mood: "enthusiasm", tag: "[excited]" },
  urgency: { delivery: "rápida, directa", pace: 1.1, intensity: 0.8, stability: 0.5, style: 0.35, pb: 50, pa: 200, mood: "suspense", tag: null },
  reflection: { delivery: "lenta, íntima", pace: 0.9, intensity: 0.3, stability: 0.65, style: 0.2, pb: 400, pa: 700, mood: "reflection", tag: "[thoughtful]" },
  solemnity: { delivery: "grave, respetuosa", pace: 0.88, intensity: 0.4, stability: 0.7, style: 0.15, pb: 500, pa: 800, mood: "none", tag: "[sad]" },
  humor_surprise: { delivery: "ligera, sorprendida", pace: 1.05, intensity: 0.6, stability: 0.45, style: 0.45, pb: 100, pa: 300, mood: "calm", tag: "[laughs]" },
  qa: { delivery: "interrogativa, abierta", pace: 1.0, intensity: 0.45, stability: 0.55, style: 0.25, pb: 150, pa: 450, mood: "calm", tag: "[curious]" },
  transition: { delivery: "neutra, de enlace", pace: 1.0, intensity: 0.3, stability: 0.65, style: 0.1, pb: 600, pa: 400, mood: "none", tag: null },
};

const CHARS_PER_SEC = 15; // español narrado ~150 palabras/min

export type DirectInput = { segment_id: string; speaker_id: string; text: string; voice_id: string; provider: SegmentDirection["provider"]; model: string;
  pronunciation?: { grapheme: string; alias: string }[] };

/** Dirige una secuencia de segmentos; aplica guardas de continuidad entre vecinos. */
export function directSegments(input: DirectInput[], opts: { mode?: "reference" | "pace" | "full" } = {}): DirectionPlan {
  const mode = opts.mode ?? "full";
  const out: SegmentDirection[] = [];
  let prev: SegmentDirection | null = null;
  let fastRun = 0;
  for (const s of input) {
    const caps = MODEL_CAPS[s.model];
    if (!caps && s.provider === "elevenlabs") throw new UnsupportedDirectionError(s.model, "modelo sin capacidades verificadas");
    const emotion: Emotion = mode === "reference" ? "calm_explanation" : classifyEmotion(s.text);
    const p = PROFILE[emotion];
    const adaptations: string[] = [];
    let pace = mode === "reference" ? 1.0 : p.pace;
    let intensity = mode === "full" ? p.intensity : 0.35;
    // Guarda: velocidad alta sostenida (>2 segmentos seguidos >1.05) → baja a 1.0
    fastRun = pace > 1.05 ? fastRun + 1 : 0;
    if (fastRun > 2) { pace = 1.0; adaptations.push("velocidad alta sostenida: speed→1.0"); fastRun = 0; }
    // Guarda: salto brusco de intensidad (>0.35) → suavizado + pausa
    let pb = mode === "full" ? p.pb : 150;
    if (prev && Math.abs(intensity - prev.intensity) > 0.35) { intensity = (intensity + prev.intensity) / 2 + (intensity > prev.intensity ? 0.1 : -0.1); pb = Math.max(pb, 400); adaptations.push("salto emocional suavizado"); }
    // Guarda: timbre — misma voz y modelo por hablante en todo el episodio
    const sameSpeaker = out.filter(o => o.speaker_id === s.speaker_id);
    if (sameSpeaker.length && (sameSpeaker[0].voice_id !== s.voice_id || sameSpeaker[0].model !== s.model)) throw new UnsupportedDirectionError(s.model, `cambio de voz/modelo para ${s.speaker_id} (cambio de timbre)`);
    // stability acotada a ±0.15 del valor base del hablante para preservar identidad (p.ej. El Duro)
    const baseStab = sameSpeaker[0]?.native.stability ?? p.stability;
    const stability = Math.min(baseStab + 0.15, Math.max(baseStab - 0.15, mode === "full" ? p.stability : 0.6));
    const tags: string[] = [];
    if (mode === "full" && p.tag) {
      if (caps?.audioTags) tags.push(p.tag);
      else adaptations.push(`etiqueta ${p.tag} no admitida por ${s.model}: se expresa con voice_settings y pausas (no se envía)`);
    }
    const useBreak = !!caps?.breakTags && mode === "full";
    const pa = mode === "full" ? p.pa : 300;
    if (!useBreak) adaptations.push("pausas aplicadas en postproceso (silencio insertado)");
    const emphasis = mode === "full" ? (s.text.match(/\b[A-ZÁÉÍÓÚÑ]{3,}\b/g) ?? []) : [];
    const pron = s.pronunciation ?? [];
    if (pron.length && !caps?.phonemeTags) adaptations.push("pronunciación vía alias (sustitución de texto), no phoneme");
    const est = Math.round(s.text.length / CHARS_PER_SEC / pace * 1000) + pb + pa;
    const seg: SegmentDirection = {
      segment_id: s.segment_id, speaker_id: s.speaker_id, text: s.text, emotion, delivery: mode === "reference" ? "neutra" : p.delivery,
      pace: Math.round(pace * 100) / 100, intensity: Math.round(Math.max(0, Math.min(1, intensity)) * 100) / 100, emphasis,
      pause_before_ms: pb, pause_after_ms: pa, pronunciation: pron, voice_id: s.voice_id, provider: s.provider, model: s.model,
      estimated_duration_ms: est, actual_duration_ms: null,
      music_cue: { mood: mode === "full" ? p.mood : "calm", level_db: emotion === "reflection" ? -30 : -24, silence_before: emotion === "revelation" },
      native: { stability: Math.round(stability * 100) / 100, similarity_boost: 0.8, style: caps?.style ? (mode === "full" ? p.style : 0) : 0, speed: Math.round(pace * 100) / 100, use_break_tags: useBreak, audio_tags: tags },
      post: { insert_silence_ms: useBreak ? 0 : pb + pa, crossfade_ms: 30, loudness_target_lufs: -16 },
      adaptations,
    };
    out.push(seg); prev = seg;
  }
  return DirectionPlan.parse({ version: DIRECTION_SCHEMA_VERSION, segments: out });
}

/** Construye el cuerpo nativo para ElevenLabs SIN llamar; falla si el plan pide algo que el modelo ignora. */
export function buildProviderRequest(seg: SegmentDirection, ctx: { previous_text?: string; next_text?: string }) {
  const caps = MODEL_CAPS[seg.model];
  if (!caps) throw new UnsupportedDirectionError(seg.model, "modelo desconocido");
  if (seg.native.audio_tags.length && !caps.audioTags) throw new UnsupportedDirectionError(seg.model, "audio tags");
  if (seg.native.use_break_tags && !caps.breakTags) throw new UnsupportedDirectionError(seg.model, "<break>");
  let text = seg.text;
  for (const p of seg.pronunciation) text = text.split(p.grapheme).join(p.alias);
  if (seg.native.audio_tags.length) text = `${seg.native.audio_tags.join(" ")} ${text}`;
  if (seg.native.use_break_tags && seg.pause_after_ms > 0) text += ` <break time="${(Math.min(seg.pause_after_ms, caps.maxBreakMs) / 1000).toFixed(1)}s" />`;
  return { model_id: seg.model, text, voice_settings: { stability: seg.native.stability, similarity_boost: seg.native.similarity_boost, style: seg.native.style, speed: seg.native.speed, use_speaker_boost: true },
    ...(caps.contextText ? { previous_text: ctx.previous_text, next_text: ctx.next_text } : {}) };
}

/** Monotonía: proporción de la emoción dominante. */
export function monotonyScore(plan: DirectionPlan): number {
  const c = new Map<string, number>();
  for (const s of plan.segments) c.set(s.emotion, (c.get(s.emotion) ?? 0) + 1);
  return Math.max(...c.values()) / plan.segments.length;
}
