/**
 * Podcast 2.0 — producción estructurada guardada en podcast_episodes.production (jsonb; migración preparada,
 * NO aplicada). Una sola fuente de verdad para: modo (individual / conversación), estilo (estándar / emocional),
 * participantes con voz o grabación propia, y turnos con IDs estables.
 */
import { z } from "zod";
import { canUsePrivateVoice, isPrivateVoice, visibleVoices, type VoiceViewer } from "@/lib/voices/private-voices";
import type { AccountVoice } from "@/lib/podcast/voices";
import { isRecordingPathFor } from "@/lib/podcast/recording";
import { getPricingConfig } from "@/lib/billing/pricing";
import { ceilLedgerUsd } from "@/lib/supply/anthropic-cost";
import { DISCLAIMER } from "./conversation";

export const PRODUCTION_VERSION = "podcast-production/1" as const;
const Id = z.string().regex(/^T\d{3,4}$/);

export const ProductionParticipant = z.object({
  id: z.enum(["A", "B"]), name: z.string().trim().min(1).max(60), role: z.string().trim().max(120).default(""),
  voice_id: z.string().regex(/^[A-Za-z0-9]{8,64}$/).nullable(), voice_name: z.string().nullable().default(null),
  /** Grabación propia: ruta en Storage por turno (propiedad comprobada). */
  recordings: z.record(Id, z.string()).default({}),
  visual: z.enum(["image"]).default("image"),
});
export const ProductionTurn = z.object({ id: Id, speaker: z.enum(["A", "B"]), text: z.string().trim().min(1).max(4000) });
export const PodcastProduction = z.object({
  version: z.literal(PRODUCTION_VERSION),
  mode: z.enum(["single", "conversation"]),
  style: z.enum(["standard", "emotional"]),
  music: z.boolean().default(false),
  participants: z.array(ProductionParticipant).min(1).max(2),
  turns: z.array(ProductionTurn).min(1).max(400),
  disclaimer: z.string().nullable().default(null),
}).superRefine((p, ctx) => {
  const ids = new Set<string>();
  p.turns.forEach((t, i) => { if (ids.has(t.id)) ctx.addIssue({ code: "custom", path: ["turns", i, "id"], message: "ID de turno repetido" }); ids.add(t.id); });
  const parts = new Map(p.participants.map((x) => [x.id, x]));
  if (p.mode === "single" && (p.participants.length !== 1 || p.turns.some((t) => t.speaker !== "A"))) ctx.addIssue({ code: "custom", message: "Narración individual: solo el participante A." });
  if (p.mode === "conversation") {
    if (p.participants.length !== 2 || !parts.has("A") || !parts.has("B")) ctx.addIssue({ code: "custom", message: "Conversación: participantes A y B." });
    const a = parts.get("A"), b = parts.get("B");
    if (a?.voice_id && a.voice_id === b?.voice_id) ctx.addIssue({ code: "custom", message: "A y B deben tener voces distintas (nunca una voz para ambos)." });
    if (!p.turns.some((t) => t.speaker === "A") || !p.turns.some((t) => t.speaker === "B")) ctx.addIssue({ code: "custom", message: "La conversación necesita turnos de A y de B." });
    if (!p.disclaimer) ctx.addIssue({ code: "custom", message: "Falta el aviso de conversación guionizada." });
  }
  for (const t of p.turns) {
    const who = parts.get(t.speaker);
    if (!who) { ctx.addIssue({ code: "custom", message: `Turno ${t.id}: hablante ${t.speaker} no existe.` }); continue; }
    if (!who.voice_id && !who.recordings[t.id]) ctx.addIssue({ code: "custom", message: `Turno ${t.id}: ${who.name} no tiene voz ni grabación.` });
  }
});
export type PodcastProduction = z.infer<typeof PodcastProduction>;

export { parseDialogue } from "./dialogue";
import { parseDialogue } from "./dialogue";
export const turnIds = (n: number) => Array.from({ length: n }, (_, i) => `T${String(i + 1).padStart(3, "0")}`);

export type ProductionInput = { mode: unknown; style: unknown; music?: unknown; dialogue: unknown;
  participants: { id: "A" | "B"; name?: unknown; role?: unknown; voiceId?: unknown }[] };

/** Valida contra las voces VISIBLES para este usuario (El Duro solo si tiene concesión). */
export function buildProduction(input: ProductionInput, voices: AccountVoice[], viewer: VoiceViewer, env: Record<string, string | undefined> = process.env):
  { ok: true; production: PodcastProduction } | { ok: false; error: string } {
  const mode = input.mode === "conversation" ? "conversation" : "single";
  let lines;
  try { lines = parseDialogue(typeof input.dialogue === "string" ? input.dialogue : "", mode); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const visible = visibleVoices(voices, viewer, env);
  const participants = [];
  for (const p of input.participants.filter((x) => mode === "conversation" || x.id === "A")) {
    const vid = typeof p.voiceId === "string" ? p.voiceId.trim() : "";
    const v = visible.find((x) => x.voiceId === vid);
    if (!v) return { ok: false, error: `Elige una voz disponible para ${p.id === "A" ? "el participante A" : "el participante B"}.` };
    if (isPrivateVoice(v) && !canUsePrivateVoice(v.voiceId, viewer, env)) return { ok: false, error: "Voz privada no autorizada." };
    participants.push({ id: p.id, name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.id, role: typeof p.role === "string" ? p.role : "", voice_id: v.voiceId, voice_name: v.name, recordings: {}, visual: "image" as const });
  }
  const ids = turnIds(lines.length);
  const parsed = PodcastProduction.safeParse({ version: PRODUCTION_VERSION, mode, style: input.style === "emotional" ? "emotional" : "standard", music: input.music === true,
    participants, turns: lines.map((l, i) => ({ id: ids[i], ...l })), disclaimer: mode === "conversation" ? DISCLAIMER : null });
  return parsed.success ? { ok: true, production: parsed.data } : { ok: false, error: parsed.error.issues[0]?.message ?? "Producción inválida." };
}

/** Asigna una grabación propia (ya subida y validada) a un turno; comprueba la ruta del dueño. */
export function attachRecording(p: PodcastProduction, userId: string, episodeId: string, turnId: string, storagePath: string): PodcastProduction {
  if (!isRecordingPathFor(userId, episodeId, storagePath)) throw new Error("RECORDING_PATH_NOT_OWNED");
  const turn = p.turns.find((t) => t.id === turnId);
  if (!turn) throw new Error("TURN_NOT_FOUND");
  const participants = p.participants.map((x) => x.id === turn.speaker ? { ...x, recordings: { ...x.recordings, [turnId]: storagePath } } : x);
  return PodcastProduction.parse({ ...p, participants });
}

/** Caracteres que irán a TTS (los turnos con grabación propia no cuentan) y reserva = suma de techos por llamada. */
export function estimateProduction(p: PodcastProduction, usdPer1kChars = getPricingConfig().elevenLabsUsdPer1kChars) {
  const parts = new Map(p.participants.map((x) => [x.id, x]));
  const tts = p.turns.filter((t) => !parts.get(t.speaker)?.recordings[t.id]);
  const characters = tts.reduce((n, t) => n + t.text.length, 0);
  const usd = tts.reduce((s, t) => s + ceilLedgerUsd(t.text.length / 1000 * usdPer1kChars), 0);
  return { characters, usd: Math.round(usd * 1e4) / 1e4, ttsTurns: tts.length, ownTurns: p.turns.length - tts.length, estimatedSeconds: Math.round(p.turns.reduce((n, t) => n + t.text.length, 0) / 15) };
}

/** Texto plano equivalente (columna script, para compatibilidad con vistas y límites existentes). */
export const productionScript = (p: PodcastProduction) => p.turns.map((t) => p.mode === "conversation" ? `${t.speaker}: ${t.text}` : t.text).join("\n\n");
