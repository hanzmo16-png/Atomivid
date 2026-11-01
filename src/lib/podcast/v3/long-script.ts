/**
 * Guion largo por segmentos (P0, 2026-11-01): «BASE DULCE», 30 min pedidos → «El modelo no respondió; se usó la
 * plantilla» y un guion de 5,9 min. Una sola llamada que escriba 30, 45 o 60 minutos no es fiable (salida de 8.000 a
 * 16.000 tokens, minutos de espera dentro de una función con límite de tiempo, y un fallo pierde todo). Aquí:
 *
 *  1. ESCALETA: una llamada corta planifica N bloques (≈5 min cada uno) con sus puntos.
 *  2. SEGMENTOS: una llamada por bloque, con la ficha de los anfitriones, la escaleta completa, lo ya cubierto y los
 *     últimos turnos literales (continuidad). Cada segmento se valida: diálogo de los dos, longitud dentro de rango,
 *     sin saludo a mitad ni despedida antes del final, sin repetir turnos anteriores.
 *  3. ENSAMBLAJE: se unen, se renumeran y se comprueba la duración total (27–33 min para 30).
 *
 * Cada paso es UNA petición HTTP (cabe holgadamente en el límite de la función) y el estado vuelve al navegador, que
 * pide el siguiente: si algo falla, se reintenta desde el último segmento válido sin perder ni volver a pagar lo hecho.
 * Las llamadas pagadas usan una clave determinista por trabajo, paso e intento: repetir la misma petición reutiliza el
 * resultado ya pagado (libro pi_paid_operations) y nunca cobra dos veces. Nunca se sustituye por la plantilla.
 *
 * Puro: sin red ni disco; el LLM se inyecta (simulado en pruebas).
 */
import { classifyTurn, coherenceIssues, episodeSeconds, fitToDuration, parseLabeledScript, targetChars, turnId, type GenerateInput, type Speaker, type Turn } from "./script";

/**
 * Minutos de conversación por segmento: ~8.000 caracteres (~3.000 tokens de salida, 40–90 s por llamada, holgado frente
 * a los 300 s de la función). Bloques de 10 min y no de 5: la política de Anthropic de la plataforma admite 20 llamadas
 * al día y 1 simultánea, así que cada llamada de más resta guiones posibles (30 min = escaleta + 3 bloques = 4 llamadas).
 */
export const SEGMENT_MINUTES = 10;
/** Hasta aquí, escaleta + un solo bloque; desde aquí, varios bloques. */
export const SINGLE_CALL_MAX_MINUTES = 12;
export const LONG_SCRIPT_MAX_MINUTES = 60;
/** Intentos pagados por paso (escaleta o segmento) en todo el trabajo: acota el costo de una respuesta inválida. */
export const MAX_ATTEMPTS_PER_STEP = 3;
/** Rango aceptado de cada segmento frente a su objetivo de caracteres, y de la duración total frente a la pedida. */
export const SEGMENT_RANGE = { min: 0.85, max: 1.4 } as const;
export const TOTAL_RANGE = { min: 0.9, max: 1.1 } as const;

export type LongInput = Required<Pick<GenerateInput, "topic" | "hostName" | "guestName" | "minutes">> & Pick<GenerateInput, "guestRole" | "hostPersonality" | "guestPersonality">;
export type PlanSegment = { title: string; points: string[] };
export type Plan = { title: string; segments: PlanSegment[] };
export type SegmentTurn = { speaker: Speaker; text: string };
export type LongScriptState = {
  v: 1; jobId: string; input: LongInput;
  plan: Plan | null;
  segments: SegmentTurn[][];
  /** Intentos pagados ya usados por paso («plan», «s0», «s1»…), para el tope y para la clave del libro. */
  attempts: Record<string, number>;
};
/** Llamada al modelo de un paso: `step` identifica el paso y el intento en el libro de gastos (clave determinista). */
export type LlmStepFn = (prompt: string, o: { step: string; maxTokens: number }) => Promise<string>;

export const segmentCount = (minutes: number) => minutes <= SINGLE_CALL_MAX_MINUTES ? 1 : Math.ceil(minutes / SEGMENT_MINUTES);
export const segmentChars = (minutes: number) => Math.round(targetChars(minutes) / segmentCount(minutes));
/** Tokens de salida de un segmento: ~3 caracteres por token en español, con holgura para el tope del rango. */
export const segmentMaxTokens = (chars: number) => Math.ceil((chars * SEGMENT_RANGE.max) / 3) + 400;
export const PLAN_MAX_TOKENS = 2500;

export class LongScriptError extends Error {
  /** recoverable: se puede reintentar desde el último segmento válido (nada se pierde ni se paga dos veces). */
  constructor(readonly code: "INVALIDO" | "AGOTADO" | "ESTADO", message: string, readonly recoverable: boolean) { super(message); this.name = "LongScriptError"; }
}

export function newLongScript(jobId: string, input: LongInput): LongScriptState {
  return { v: 1, jobId, input, plan: null, segments: [], attempts: {} };
}

/** Misma normalización que usa el servidor para decidir si un trabajo guardado sigue siendo el mismo (y no se vuelve a pagar). */
export function normalizeLongInput(b: { topic?: unknown; minutes?: unknown; hostName?: unknown; guestName?: unknown; guestRole?: unknown; hostPersonality?: unknown; guestPersonality?: unknown }): LongInput {
  const topic = String(b.topic ?? "").trim().slice(0, 2000);
  const minutes = Math.round(Math.min(LONG_SCRIPT_MAX_MINUTES, Math.max(1, Number(b.minutes) || 5)));
  return {
    topic, minutes,
    hostName: String(b.hostName ?? "Anfitrión").slice(0, 60) || "Anfitrión",
    guestName: String(b.guestName ?? "Invitado").slice(0, 60) || "Invitado",
    guestRole: String(b.guestRole ?? "").slice(0, 120),
    hostPersonality: String(b.hostPersonality ?? "").slice(0, 300),
    guestPersonality: String(b.guestPersonality ?? "").slice(0, 300),
  };
}

export function sameLongInput(stored: unknown, next: LongInput): boolean {
  if (!stored || typeof stored !== "object") return false;
  const s = stored as Partial<LongInput>;
  return s.topic === next.topic && s.minutes === next.minutes && s.hostName === next.hostName && s.guestName === next.guestName
    && String(s.guestRole ?? "") === String(next.guestRole ?? "")
    && String(s.hostPersonality ?? "") === String(next.hostPersonality ?? "")
    && String(s.guestPersonality ?? "") === String(next.guestPersonality ?? "");
}

const people = (i: LongInput) => [
  `- ${i.hostName} (anfitrión/a)${i.hostPersonality ? `: ${i.hostPersonality}` : ""}`,
  `- ${i.guestName}${i.guestRole ? ` (${i.guestRole})` : " (coanfitrión/a)"}${i.guestPersonality ? `: ${i.guestPersonality}` : ""}`,
].join("\n");

export function planPrompt(i: LongInput): string {
  const n = segmentCount(i.minutes);
  return [
    `Vas a planificar un episodio de podcast en español latinoamericano de ${i.minutes} minutos, una conversación natural entre dos personas:`,
    people(i),
    `Tema y enfoque pedidos por el usuario:\n«${i.topic}»`,
    `Divide el episodio en exactamente ${n} bloques consecutivos de unos ${Math.round(i.minutes / n)} minutos cada uno, con un arco claro: apertura que engancha, desarrollo que avanza sin repetirse y un cierre con conclusión.`,
    "Cada bloque cubre puntos DISTINTOS (nada se trata dos veces). Distingue siempre afirmaciones, rumores y evidencia verificable; no inventes citas, fechas ni documentos.",
    `Responde SOLO con JSON válido, sin texto adicional, con esta forma exacta:\n{"titulo":"…","bloques":[{"titulo":"…","puntos":["…","…","…"]}]}`,
    `Cada bloque lleva entre 4 y 8 puntos concretos. El arreglo "bloques" tiene exactamente ${n} elementos.`,
  ].join("\n\n");
}

/** Escaleta del modelo → Plan validado (n bloques, títulos y puntos no vacíos); null si no sirve. */
export function parsePlan(text: string, n: number): Plan | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let raw: unknown;
  try { raw = JSON.parse(m[0]); } catch { return null; }
  const o = raw as { titulo?: unknown; bloques?: unknown };
  if (!Array.isArray(o.bloques) || o.bloques.length !== n) return null;
  const segments: PlanSegment[] = [];
  for (const b of o.bloques as { titulo?: unknown; puntos?: unknown }[]) {
    const title = String(b?.titulo ?? "").trim().slice(0, 160);
    const points = Array.isArray(b?.puntos) ? b.puntos.map((p) => String(p ?? "").trim().slice(0, 300)).filter(Boolean).slice(0, 10) : [];
    if (!title || points.length < 2) return null;
    segments.push({ title, points });
  }
  return { title: String(o.titulo ?? "").trim().slice(0, 160) || segments[0].title, segments };
}

const CONTEXT_TURNS = 6;
export function segmentPrompt(s: LongScriptState, k: number): string {
  const i = s.input, plan = s.plan!, n = plan.segments.length, chars = segmentChars(i.minutes), words = Math.round(chars / 6);
  const first = k === 0, last = k === n - 1;
  const outline = plan.segments.map((b, j) => `${j + 1}. ${b.title}${j < k ? " (ya cubierto)" : j === k ? " ← ESTE BLOQUE" : ""}\n${b.points.map((p) => `   - ${p}`).join("\n")}`).join("\n");
  const prev = s.segments.flat().slice(-CONTEXT_TURNS).map((t) => `${t.speaker === "A" ? i.hostName : i.guestName}: ${t.text}`).join("\n");
  return [
    `Escribe el bloque ${k + 1} de ${n} de un episodio de podcast en español latinoamericano de ${i.minutes} minutos: «${plan.title}».`,
    `Participantes (mantén su identidad, voz y personalidad en todo el episodio):\n${people(i)}`,
    `Tema y enfoque del episodio:\n«${i.topic}»`,
    `Escaleta completa:\n${outline}`,
    ...(prev ? [`Así terminó el bloque anterior (continúa EXACTAMENTE desde aquí, sin repetirlo ni resumirlo):\n${prev}`] : []),
    `Extensión de ESTE bloque: entre ${Math.round(words * 0.95)} y ${Math.round(words * 1.1)} palabras habladas (unos ${Math.round(chars / 13.5 / 60)} minutos). La duración se cumple con contenido, no con relleno.`,
    [
      "Reglas:",
      "- Formato estricto: una línea por turno, «Nombre: texto», solo con los dos nombres de arriba. Sin acotaciones, títulos, viñetas ni markdown.",
      "- Conversación natural: preguntas, respuestas, réplicas breves, humor inteligente, al menos un desacuerdo razonado; nadie habla más de tres turnos seguidos.",
      "- Cubre los puntos de ESTE bloque, en orden lógico. No adelantes los de bloques siguientes ni repitas lo ya cubierto.",
      "- Distingue afirmaciones, rumores y evidencia verificable; si algo no está comprobado, dilo. No inventes citas textuales, cifras ni documentos.",
      first ? "- Empieza con la presentación del episodio y de los participantes." : "- NO saludes ni presentes el programa de nuevo: estamos a mitad de episodio.",
      last ? "- Termina con una conclusión y la despedida del episodio." : "- NO te despidas ni cierres el episodio: termina con una transición natural hacia el siguiente bloque.",
    ].join("\n"),
  ].join("\n\n");
}

const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]/g, "").replace(/\s+/g, " ").trim();
/** Réplicas breves («Sí.», «Exacto.») pueden volver entre bloques; un turno largo copiado, no. */
const DUPLICATE_TURN_MIN_CHARS = 40;
const GREETING = /\b(bienvenid[oa]s?|hola a todos|hola,? (amigos|oyentes))\b/i;
const FAREWELL = /\b(hasta la pr[oó]xima|gracias por (escucharnos|escuchar|acompa[nñ]arnos)|nos despedimos|nos vemos en el pr[oó]ximo|hasta el pr[oó]ximo episodio)\b/i;

/** Motivos por los que un segmento no sirve (vacío = válido). */
export function segmentIssues(turns: SegmentTurn[], s: LongScriptState, k: number): string[] {
  const out: string[] = [];
  const n = s.plan!.segments.length, target = segmentChars(s.input.minutes);
  const chars = turns.reduce((m, t) => m + t.text.length, 0);
  if (chars < target * SEGMENT_RANGE.min) out.push(`corto: ${chars} de ${target} caracteres`);
  if (chars > target * SEGMENT_RANGE.max) out.push(`largo: ${chars} de ${target} caracteres`);
  const asTurns: Turn[] = turns.map((t, j) => ({ id: turnId(j), speaker: t.speaker, text: t.text, kind: "comentario" }));
  out.push(...coherenceIssues(asTurns));
  const seen = new Set(s.segments.flat().map((t) => norm(t.text)).filter((t) => t.length >= DUPLICATE_TURN_MIN_CHARS));
  const repeated = turns.filter((t) => { const n = norm(t.text); return n.length >= DUPLICATE_TURN_MIN_CHARS && seen.has(n); }).length;
  if (repeated) out.push(`${repeated} turnos repetidos de bloques anteriores`);
  if (k > 0 && turns.slice(0, 2).some((t) => GREETING.test(t.text))) out.push("vuelve a saludar a mitad de episodio");
  if (k < n - 1 && turns.slice(-3).some((t) => FAREWELL.test(t.text))) out.push("se despide antes del final");
  return out;
}

function parseSegment(text: string, i: LongInput): SegmentTurn[] | null {
  const p = parseLabeledScript(text.replace(/^```\w*|```$/gm, ""), { A: i.hostName, B: i.guestName });
  if (!p) return null;
  // Solo los dos nombres del episodio: una tercera voz o etiquetas inventadas invalidan el segmento.
  return p.turns.map((t) => ({ speaker: t.speaker, text: t.text }));
}

export type StepResult = { state: LongScriptState; done: boolean; step: number; steps: number; note?: string };
export const totalSteps = (s: LongScriptState) => 1 + segmentCount(s.input.minutes);

function nextAttempt(s: LongScriptState, key: string): number {
  const used = s.attempts[key] ?? 0;
  if (used >= MAX_ATTEMPTS_PER_STEP) throw new LongScriptError("AGOTADO", `El modelo no logró un resultado válido para ${key === "plan" ? "la escaleta" : `el bloque ${Number(key.slice(1)) + 1}`} tras ${MAX_ATTEMPTS_PER_STEP} intentos. No se usó ninguna plantilla; puedes volver a empezar.`, false);
  return used + 1;
}

/**
 * Avanza UN paso (escaleta o siguiente segmento). Un error del proveedor se propaga tal cual (el llamador lo traduce a
 * un mensaje claro y recuperable); el estado recibido no cambia, así que reintentar repite exactamente la misma
 * petición (misma clave: si ya se pagó, se reutiliza). Una respuesta inválida consume un intento y lanza INVALIDO.
 */
export async function advanceLongScript(s: LongScriptState, llm: LlmStepFn): Promise<StepResult> {
  const n = segmentCount(s.input.minutes), steps = 1 + n;
  if (!s.plan) {
    const attempt = nextAttempt(s, "plan");
    const text = await llm(planPrompt(s.input), { step: `plan-a${attempt}`, maxTokens: PLAN_MAX_TOKENS });
    const plan = parsePlan(text, n);
    const state = { ...s, attempts: { ...s.attempts, plan: attempt } };
    if (!plan) throw Object.assign(new LongScriptError("INVALIDO", "La escaleta del modelo no tenía el formato esperado; reintenta (no se perdió nada).", true), { state });
    return { state: { ...state, plan }, done: false, step: 1, steps };
  }
  const k = s.segments.length;
  if (k >= n) return { state: s, done: true, step: steps, steps };
  const key = `s${k}`, attempt = nextAttempt(s, key);
  const text = await llm(segmentPrompt(s, k), { step: `${key}-a${attempt}`, maxTokens: segmentMaxTokens(segmentChars(s.input.minutes)) });
  const turns = parseSegment(text, s.input);
  const state = { ...s, attempts: { ...s.attempts, [key]: attempt } };
  const issues = turns ? segmentIssues(turns, s, k) : ["no es un diálogo con los dos participantes"];
  if (!turns || issues.length) throw Object.assign(new LongScriptError("INVALIDO", `El bloque ${k + 1} de ${n} no cumplió los requisitos (${issues.join("; ")}); reintenta desde ahí (lo anterior se conserva).`, true), { state });
  const next = { ...state, segments: [...s.segments, turns] };
  return { state: next, done: next.segments.length === n, step: 2 + k, steps };
}

/** Une los segmentos en el guion final y comprueba la duración total frente a la pedida (sin relleno ni voz lenta). */
export function assembleLongScript(s: LongScriptState): { turns: Turn[]; estimatedMinutes: number; withinTarget: boolean; trimmed: number } {
  const flat = s.segments.flat();
  const raw: Turn[] = flat.map((t, j) => ({ id: turnId(j), speaker: t.speaker, text: t.text, kind: classifyTurn(t.text, j, flat.length) }));
  const fitted = fitToDuration(raw, s.input.minutes);
  const estimatedMinutes = Math.round((episodeSeconds(fitted.turns) / 60) * 10) / 10;
  const ratio = estimatedMinutes / s.input.minutes;
  return { turns: fitted.turns, estimatedMinutes, withinTarget: ratio >= TOTAL_RANGE.min && ratio <= TOTAL_RANGE.max, trimmed: fitted.trimmed };
}

/** Valida un estado que llega del navegador (forma, tamaños y coherencia con la entrada); lanza ESTADO si no sirve. */
export function checkLongState(x: unknown, input: LongInput): LongScriptState {
  const bad = (why: string) => new LongScriptError("ESTADO", `El progreso guardado no es válido (${why}); vuelve a empezar.`, false);
  const s = x as LongScriptState;
  if (!s || s.v !== 1 || typeof s.jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(s.jobId)) throw bad("versión o identificador");
  const n = segmentCount(input.minutes);
  if (!Array.isArray(s.segments) || s.segments.length > n) throw bad("segmentos");
  if (s.plan !== null && (!s.plan || !Array.isArray(s.plan.segments) || s.plan.segments.length !== n)) throw bad("escaleta");
  if (s.plan === null && s.segments.length) throw bad("segmentos sin escaleta");
  const limit = segmentChars(input.minutes) * SEGMENT_RANGE.max * 1.2;
  for (const seg of s.segments) {
    if (!Array.isArray(seg) || !seg.length || seg.length > 300) throw bad("segmento");
    let c = 0;
    for (const t of seg) { if ((t?.speaker !== "A" && t?.speaker !== "B") || typeof t.text !== "string") throw bad("turno"); c += t.text.length; }
    if (c > limit) throw bad("segmento demasiado largo");
  }
  const attempts: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.attempts ?? {})) if (/^(plan|s\d{1,2})$/.test(k) && Number.isInteger(v) && v >= 0 && v <= MAX_ATTEMPTS_PER_STEP) attempts[k] = v;
  const plan = s.plan ? { title: String(s.plan.title ?? "").slice(0, 160), segments: s.plan.segments.map((b) => ({ title: String(b?.title ?? "").slice(0, 160), points: (Array.isArray(b?.points) ? b.points : []).slice(0, 10).map((p) => String(p).slice(0, 300)) })) } : null;
  return { v: 1, jobId: s.jobId.toLowerCase(), input, plan, segments: s.segments.map((seg) => seg.map((t) => ({ speaker: t.speaker, text: t.text.replace(/\s+/g, " ").trim() }))), attempts };
}
