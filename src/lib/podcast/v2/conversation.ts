/** Podcast 2.0 — Conversación de dos participantes: contrato, generador determinista de plantilla y validación. */
import { z } from "zod";

export const Participant = z.object({
  id: z.enum(["A", "B"]), display_name: z.string().min(1),
  source: z.enum(["private_voice", "own_recording", "stock_voice", "mock"]),
  voice_id: z.string().nullable(), visual: z.enum(["none", "avatar", "image"]),
});
export const Turn = z.object({
  turn_id: z.string(), speaker: z.enum(["A", "B"]), text: z.string().min(1),
  kind: z.enum(["question", "answer", "follow_up", "disagreement", "reaction", "clarification", "transition", "surprise"]),
  claim: z.enum(["documented_fact", "hypothesis", "dramatization", "opinion"]),
  source_url: z.string().url().nullable(), gap_after_ms: z.number().int().min(0).max(2000),
});
export const Conversation = z.object({
  version: z.literal("podcast-conversation/1"), topic: z.string().min(3), target_minutes: z.number().min(1).max(60),
  participants: z.tuple([Participant, Participant]), turns: z.array(Turn).min(4),
  disclaimer: z.string().min(10),
}).superRefine((c, ctx) => {
  if (c.participants[0].id !== "A" || c.participants[1].id !== "B") ctx.addIssue({ code: "custom", message: "participantes deben ser A y B" });
  if (c.participants[0].source === c.participants[1].source && c.participants[0].voice_id && c.participants[0].voice_id === c.participants[1].voice_id)
    ctx.addIssue({ code: "custom", message: "A y B no pueden usar la misma voz" });
  c.turns.forEach((t, i) => {
    if (t.claim === "documented_fact" && !t.source_url) ctx.addIssue({ code: "custom", path: ["turns", i], message: "hecho documentado sin fuente" });
  });
});
export type Conversation = z.infer<typeof Conversation>;
export type Turn = z.infer<typeof Turn>;

export const DISCLAIMER = "Conversación guionizada y dramatizada con voces sintéticas o grabadas; no es una entrevista real. Hechos con fuente marcados; hipótesis y dramatización señaladas.";

/** Detecta problemas de diálogo objetivos. */
export function dialogueIssues(c: Conversation): string[] {
  const issues: string[] = [];
  let run = 1;
  for (let i = 1; i < c.turns.length; i++) {
    run = c.turns[i].speaker === c.turns[i - 1].speaker ? run + 1 : 1;
    if (run > 3) issues.push(`T${i}: ${c.turns[i].speaker} habla ${run} turnos seguidos (participante confundido/monólogo)`);
  }
  const filler = /\b(eh+|este+|o sea|bueno bueno|exacto exacto)\b/gi;
  const fillers = c.turns.reduce((n, t) => n + (t.text.match(filler)?.length ?? 0), 0);
  if (fillers > c.turns.length * 0.3) issues.push(`exceso de muletillas (${fillers})`);
  const seen = new Map<string, number>();
  c.turns.forEach((t, i) => { const k = t.text.toLowerCase().replace(/[^a-záéíóúñ ]/g, "").slice(0, 60); if (seen.has(k)) issues.push(`T${i} repite T${seen.get(k)}`); else seen.set(k, i); });
  const kinds = new Set(c.turns.map(t => t.kind));
  for (const k of ["question", "answer", "follow_up"] as const) if (!kinds.has(k)) issues.push(`falta intercambio tipo ${k}`);
  const qs = c.turns.filter(t => t.kind === "question").length, ans = c.turns.filter(t => t.kind === "answer").length;
  if (qs > ans * 2) issues.push("preguntas sin respuesta");
  if (c.turns.some(t => t.gap_after_ms === 0) && c.turns.every(t => t.gap_after_ms === c.turns[0].gap_after_ms)) issues.push("pausas mecánicas idénticas");
  return issues;
}

/** Variación de pausa entre turnos determinista por tipo (no aleatoria). */
export function gapFor(kind: Turn["kind"], nextKind?: Turn["kind"]): number {
  if (kind === "question") return 350;
  if (kind === "surprise" || kind === "reaction") return 200;
  if (kind === "transition" || nextKind === "transition") return 900;
  if (kind === "disagreement") return 500;
  return 420;
}
