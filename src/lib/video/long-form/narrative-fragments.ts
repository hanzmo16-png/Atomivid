import { z } from "zod";
import { DocumentaryResponseError } from "./json-response";
import { LONG_FORM_MAX_BEATS } from "./duration-budget";

/** fragments-v1: the writer emits the narrative as independent, numbered
 * fragments (one plan + one object per beat). Each fragment is validated on its
 * own, so a truncated or partly malformed response keeps every COMPLETE fragment.
 * A continuation asks only for the missing fragment numbers and receives the
 * saved ones as context; the application assembles and validates the document.
 * Nothing partial is ever "repaired": an incomplete object is simply absent. */
export const FRAGMENT_CONTRACT = "fragments-v1" as const;
export const MAX_CONTINUATIONS = 3;

type Message = { stop_reason: string | null; content: Array<{ type: string; text?: string }> };
type AnyObject = z.ZodObject<z.ZodRawShape>;

export type FragmentSet<P, B> = { plan?: P; beats: Map<number, B>; rejected: number };

/** Top-level JSON objects in order, string- and escape-aware. An unterminated
 * trailing object (truncation) is not returned. Works for JSON Lines and for
 * pretty-printed objects separated by whitespace. */
export function topLevelObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { if (depth > 0) inString = true; continue; }
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}" && depth > 0) { depth--; if (depth === 0) { out.push(text.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

const narrationKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").slice(0, 12).join(" ");

/** Merge the complete fragments of one response into the saved set. First valid
 * fragment per number wins; a beat whose opening repeats a saved beat is refused
 * (counted as rejected), so a continuation can never duplicate paragraphs. */
export function collectFragments<P, B extends { narration: string }>(
  set: FragmentSet<P, B>, message: Message, planSchema: z.ZodType<P>, beatSchema: z.ZodType<B>,
): FragmentSet<P, B> {
  const text = message.content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
  const next: FragmentSet<P, B> = { plan: set.plan, beats: new Map(set.beats), rejected: set.rejected };
  for (const raw of topLevelObjects(text)) {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { next.rejected++; continue; }
    const kind = (value as { fragment?: unknown })?.fragment;
    if (kind === "plan") {
      const parsed = planSchema.safeParse(value);
      if (!parsed.success) { next.rejected++; continue; }
      next.plan ??= parsed.data;
    } else if (kind === "beat") {
      const parsed = beatSchema.safeParse(value);
      const index = (value as { index?: unknown }).index;
      if (!parsed.success || !Number.isInteger(index) || (index as number) < 0 || (index as number) > LONG_FORM_MAX_BEATS - 1) { next.rejected++; continue; }
      if (next.beats.has(index as number)) continue;
      const key = narrationKey(parsed.data.narration);
      if ([...next.beats.values()].some(b => narrationKey(b.narration) === key)) { next.rejected++; continue; }
      next.beats.set(index as number, parsed.data);
    } else next.rejected++;
  }
  return next;
}

/** Fragments still required. The plan fixes the beat count (one storyPlan section per beat). */
export function missingFragments(set: FragmentSet<{ storyPlan: { sections: unknown[] } }, unknown>): { plan: boolean; beats: number[] } {
  if (!set.plan) return { plan: true, beats: [] };
  const count = set.plan.storyPlan.sections.length;
  return { plan: false, beats: Array.from({ length: count }, (_, i) => i).filter(i => !set.beats.has(i)) };
}

export function fragmentOutputContract(planSchema: AnyObject, beatSchema: AnyObject): string {
  return `OUTPUT CONTRACT (${FRAGMENT_CONTRACT}): devuelve fragmentos JSON independientes, uno por línea, sin markdown ni comentarios.
Primero {"fragment":"plan", ...}. Después un objeto por beat, en orden: {"fragment":"beat","index":0, ...}, {"fragment":"beat","index":1, ...}.
Termina por completo cada fragmento antes de empezar el siguiente. Cada fragmento se valida por separado.
Esquema del plan: ${JSON.stringify(z.toJSONSchema(planSchema, { reused: "ref" }))}
Esquema de cada beat: ${JSON.stringify(z.toJSONSchema(beatSchema, { reused: "ref" }))}`;
}

/** Continuation from a safe structural boundary: the saved fragments are data and
 * must not be rewritten; only the listed numbers are requested. */
export function continuationPrompt(basePrompt: string, set: FragmentSet<unknown, { type: string; purpose: string; narration: string }>, missing: { plan: boolean; beats: number[] }): string {
  const saved = [...set.beats.entries()].sort((a, b) => a[0] - b[0]).map(([index, b]) => ({ index, type: b.type, purpose: b.purpose, narration: b.narration }));
  const wanted = [...(missing.plan ? ["plan"] : []), ...missing.beats.map(i => `beat ${i}`)];
  return `${basePrompt}

CONTINUACIÓN ESTRUCTURADA (${FRAGMENT_CONTRACT}). La respuesta anterior quedó incompleta. Estos fragmentos YA están guardados y son definitivos; no los repitas ni los reescribas.
Devuelve SOLO estos fragmentos, con el mismo formato: ${wanted.join(", ")}.
Continúa la historia sin repetir ideas ni frases de los bloques guardados y respeta el plan guardado.
PLAN GUARDADO (datos): ${JSON.stringify(set.plan ?? null)}
BLOQUES GUARDADOS (datos): ${JSON.stringify(saved)}`;
}

/** Drive one writer draft to completeness: first call, then at most
 * MAX_CONTINUATIONS calls for missing fragments only. Each call goes through the
 * paid-call ledger, so an interruption replays saved responses for free. */
export async function writeFragmentDraft<P extends { storyPlan: { sections: unknown[] } }, B extends { type: string; purpose: string; narration: string }>(args: {
  prompt: string;
  send: (prompt: string) => Promise<Message>;
  planSchema: z.ZodType<P>;
  beatSchema: z.ZodType<B>;
  onContinuation?: (missing: { plan: boolean; beats: number[] }) => Promise<void>;
}): Promise<{ plan: P; beats: B[]; calls: number }> {
  let set: FragmentSet<P, B> = { beats: new Map(), rejected: 0 };
  let prompt = args.prompt, calls = 0;
  for (;;) {
    const message = await args.send(prompt);
    calls++;
    if (!["end_turn", "max_tokens"].includes(message.stop_reason ?? "")) throw new DocumentaryResponseError("El modelo no completó la respuesta.");
    set = collectFragments(set, message, args.planSchema, args.beatSchema);
    const missing = missingFragments(set);
    if (!missing.plan && !missing.beats.length) {
      const count = set.plan!.storyPlan.sections.length;
      return { plan: set.plan!, beats: Array.from({ length: count }, (_, i) => set.beats.get(i)!), calls };
    }
    if (calls > MAX_CONTINUATIONS) {
      throw new DocumentaryResponseError(`El guion quedó incompleto tras ${MAX_CONTINUATIONS} continuaciones: faltan ${missing.plan ? "el plan" : `los bloques ${missing.beats.map(i => i + 1).join(", ")}`}. Los bloques completos están guardados.`);
    }
    await args.onContinuation?.(missing);
    prompt = continuationPrompt(args.prompt, set, missing);
  }
}
