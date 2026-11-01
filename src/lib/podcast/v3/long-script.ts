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
/**
 * Caracteres por palabra HABLADA del texto que mide el estudio (sin «Nombre:»). Incidente 2026-11-01 («BASE DULCE»,
 * bloque 1 de 3: «corto: 6577 de 7852»): el prompt pedía chars/6 = 1.243–1.440 palabras y el modelo escribió el mínimo,
 * 1.243 palabras = 6.577 caracteres (5,29 car./palabra en español conversacional). Con 6 car./palabra, un modelo que
 * CUMPLE lo pedido queda por debajo del 85 % y se rechaza. 5,3 es lo medido.
 */
export const CHARS_PER_SPOKEN_WORD = 5.3;
/**
 * Por debajo de esto la respuesta no sirve (otro intento completo). Entre esto y SEGMENT_RANGE.min el bloque se COMPLETA
 * (se compensa o se amplía): ampliar paga solo lo que falta y conserva lo escrito; repetirlo pagaría el bloque entero.
 */
export const SEGMENT_HARD_MIN = 0.25;
/** Un bloque posterior que absorbe el déficit de uno corto no se pide más largo que esto (frente a su tamaño base). */
export const ABSORB_MAX = 1.35;
/** Ampliaciones por bloque (continuar el MISMO bloque sin repetirlo); pasadas estas, se conserva lo escrito. */
export const MAX_EXTENSIONS_PER_BLOCK = 2;

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
  /**
   * Bloque `k` escrito pero aún corto, a la espera de su ampliación número `ext + 1` (clave «s<k>-a<attempt>-x<m>»).
   * Lo ya escrito se conserva aquí: un fallo de red o del proveedor durante la ampliación no lo pierde.
   */
  partial?: { k: number; attempt: number; ext: number; turns: SegmentTurn[] } | null;
};
/** Respuesta del modelo: el texto y, si el adaptador lo sabe, por qué paró («max_tokens» = truncada). */
export type LlmStepOut = string | { text: string; stopReason?: string | null };
/** Llamada al modelo de un paso: `step` identifica el paso y el intento en el libro de gastos (clave determinista). */
export type LlmStepFn = (prompt: string, o: { step: string; maxTokens: number }) => Promise<LlmStepOut>;

export const segmentCount = (minutes: number) => minutes <= SINGLE_CALL_MAX_MINUTES ? 1 : Math.ceil(minutes / SEGMENT_MINUTES);
export const segmentChars = (minutes: number) => Math.round(targetChars(minutes) / segmentCount(minutes));
/** Tokens de salida de un segmento: ~3 caracteres por token en español, con holgura para el tope del rango. */
export const segmentMaxTokens = (chars: number) => Math.ceil((chars * SEGMENT_RANGE.max) / 3) + 400;
const charsOf = (turns: { text: string }[]) => turns.reduce((m, t) => m + t.text.length, 0);
/**
 * Objetivo del bloque `k`: lo que falta para la duración pedida repartido entre los bloques que quedan (si un bloque
 * salió corto, los siguientes lo compensan con CONTENIDO), acotado a [0,6; ABSORB_MAX] del tamaño base.
 */
export function blockTarget(s: LongScriptState, k: number): number {
  const n = s.plan?.segments.length ?? segmentCount(s.input.minutes), base = segmentChars(s.input.minutes);
  const remaining = Math.max(0, targetChars(s.input.minutes) - charsOf(s.segments.flat()));
  return Math.round(Math.min(base * ABSORB_MAX, Math.max(base * 0.6, remaining / Math.max(1, n - k))));
}
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
  const i = s.input, plan = s.plan!, n = plan.segments.length, chars = blockTarget(s, k), words = Math.round(chars / CHARS_PER_SPOKEN_WORD);
  const first = k === 0, last = k === n - 1;
  const outline = plan.segments.map((b, j) => `${j + 1}. ${b.title}${j < k ? " (ya cubierto)" : j === k ? " ← ESTE BLOQUE" : ""}\n${b.points.map((p) => `   - ${p}`).join("\n")}`).join("\n");
  const prev = s.segments.flat().slice(-CONTEXT_TURNS).map((t) => `${t.speaker === "A" ? i.hostName : i.guestName}: ${t.text}`).join("\n");
  return [
    `Escribe el bloque ${k + 1} de ${n} de un episodio de podcast en español latinoamericano de ${i.minutes} minutos: «${plan.title}».`,
    `Participantes (mantén su identidad, voz y personalidad en todo el episodio):\n${people(i)}`,
    `Tema y enfoque del episodio:\n«${i.topic}»`,
    `Escaleta completa:\n${outline}`,
    ...(prev ? [`Así terminó el bloque anterior (continúa EXACTAMENTE desde aquí, sin repetirlo ni resumirlo):\n${prev}`] : []),
    `Extensión de ESTE bloque: entre ${words} y ${Math.round(words * 1.15)} palabras habladas (unos ${Math.round(chars / 13.5 / 60)} minutos de audio). Es un mínimo real: un bloque más corto deja el episodio por debajo de lo pedido. La duración se cumple con contenido (ejemplos, matices, réplicas), no con relleno ni repeticiones.`,
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

/**
 * Defectos de FORMA de un segmento (vacío = válido): diálogo de los dos, sin monólogos, sin turnos largos copiados de
 * bloques anteriores, sin saludo a mitad ni despedida antes del final. La longitud se juzga aparte (blockVerdict).
 */
export function segmentFormIssues(turns: SegmentTurn[], s: LongScriptState, k: number, o: { allowFarewell?: boolean; before?: SegmentTurn[] } = {}): string[] {
  const out: string[] = [];
  const n = s.plan!.segments.length;
  const asTurns: Turn[] = turns.map((t, j) => ({ id: turnId(j), speaker: t.speaker, text: t.text, kind: "comentario" }));
  out.push(...coherenceIssues(asTurns));
  const seen = new Set([...s.segments.flat(), ...(o.before ?? [])].map((t) => norm(t.text)).filter((t) => t.length >= DUPLICATE_TURN_MIN_CHARS));
  const repeated = turns.filter((t) => { const x = norm(t.text); return x.length >= DUPLICATE_TURN_MIN_CHARS && seen.has(x); }).length;
  if (repeated) out.push(`${repeated} turnos repetidos de lo ya escrito`);
  if ((k > 0 || o.before?.length) && turns.slice(0, 2).some((t) => GREETING.test(t.text))) out.push("vuelve a saludar a mitad de episodio");
  const farewellOk = o.allowFarewell ?? k === n - 1;
  if (!farewellOk && turns.slice(-3).some((t) => FAREWELL.test(t.text))) out.push("se despide antes del final");
  return out;
}

/** Motivos por los que un segmento recién escrito no sirve: forma, o longitud fuera de [SEGMENT_HARD_MIN, máx.]. */
export function segmentIssues(turns: SegmentTurn[], s: LongScriptState, k: number): string[] {
  const target = blockTarget(s, k), chars = charsOf(turns);
  // El tope de «largo» no baja porque un bloque anterior se pasara: el exceso total lo recorta fitToDuration.
  const ceiling = Math.max(target, segmentChars(s.input.minutes)) * SEGMENT_RANGE.max;
  const out: string[] = [];
  if (chars < target * SEGMENT_HARD_MIN) out.push(`demasiado corto: ${chars} de ${target} caracteres`);
  if (chars > ceiling) out.push(`largo: ${chars} de ${Math.round(ceiling / SEGMENT_RANGE.max)} caracteres`);
  return [...out, ...segmentFormIssues(turns, s, k)];
}

/** Texto y truncado de la respuesta: «max_tokens», o una última línea que se corta sin puntuación final. */
function readOut(out: LlmStepOut): { text: string; truncated: boolean } {
  const text = typeof out === "string" ? out : String(out?.text ?? "");
  const stop = typeof out === "string" ? null : out?.stopReason ?? null;
  const lastLine = text.replace(/```\s*$/g, "").trim().split("\n").filter((l) => l.trim()).at(-1) ?? "";
  return { text, truncated: stop === "max_tokens" || (lastLine.length > 0 && !/[.!?…»"”)\]]\s*$/.test(lastLine)) };
}

/** Turnos de la respuesta; si llegó truncada, el último turno (a medias) se descarta en vez de entrar al guion. */
export function parseSegment(out: LlmStepOut, i: LongInput): { turns: SegmentTurn[]; truncated: boolean } | null {
  const { text, truncated } = readOut(out);
  const p = parseLabeledScript(text.replace(/^```\w*|```$/gm, ""), { A: i.hostName, B: i.guestName });
  if (!p) return null;
  // Solo los dos nombres del episodio: una tercera voz o etiquetas inventadas invalidan el segmento.
  const turns = p.turns.map((t) => ({ speaker: t.speaker, text: t.text }));
  if (truncated && turns.length > 1) turns.pop();
  return { turns, truncated };
}

export type StepPhase = "escaleta" | "bloque" | "ampliando";
export type StepResult = { state: LongScriptState; done: boolean; step: number; steps: number; phase: StepPhase; note?: string };
export const totalSteps = (s: LongScriptState) => 1 + segmentCount(s.input.minutes);

function nextAttempt(s: LongScriptState, key: string): number {
  const used = s.attempts[key] ?? 0;
  if (used >= MAX_ATTEMPTS_PER_STEP) throw new LongScriptError("AGOTADO", `El modelo no logró un resultado válido para ${key === "plan" ? "la escaleta" : `el bloque ${Number(key.slice(1)) + 1}`} tras ${MAX_ATTEMPTS_PER_STEP} intentos. No se usó ninguna plantilla; puedes volver a empezar.`, false);
  return used + 1;
}

/** Último bloque: separa el cierre (desde la primera despedida de los 3 últimos turnos, o el último turno). */
function splitClosing(turns: SegmentTurn[]): { body: SegmentTurn[]; closing: SegmentTurn[] } {
  const tail = Math.max(0, turns.length - 3);
  let at = turns.findIndex((t, j) => j >= tail && FAREWELL.test(t.text));
  if (at < 1) at = Math.max(1, turns.length - 1);
  return { body: turns.slice(0, at), closing: turns.slice(at) };
}

/**
 * ¿Basta el bloque `k` con estos turnos? Sí si llega al 85 % de su objetivo. Si no llega pero los bloques siguientes
 * pueden compensarlo sin pasar de ABSORB_MAX, también (se compensa con contenido, no con relleno). En el último
 * bloque cuenta además la duración total. Si no basta y quedan ampliaciones, toca ampliar el MISMO bloque.
 */
function blockVerdict(s: LongScriptState, k: number, turns: SegmentTurn[], ext: number): "aceptar" | "compensar" | "ampliar" | "conservar" {
  const n = s.plan!.segments.length, base = segmentChars(s.input.minutes), target = blockTarget(s, k), chars = charsOf(turns);
  const written = charsOf(s.segments.flat()) + chars, total = targetChars(s.input.minutes);
  if (k === n - 1) {
    if (written >= total * TOTAL_RANGE.min) return "aceptar";
  } else {
    if (chars >= target * SEGMENT_RANGE.min) return "aceptar";
    if ((total - written) / (n - k - 1) <= base * ABSORB_MAX) return "compensar";
  }
  return ext < MAX_EXTENSIONS_PER_BLOCK ? "ampliar" : "conservar";
}

export function extensionPrompt(s: LongScriptState, p: NonNullable<LongScriptState["partial"]>): string {
  const i = s.input, plan = s.plan!, n = plan.segments.length, k = p.k, last = k === n - 1;
  const { body, closing } = last ? splitClosing(p.turns) : { body: p.turns, closing: [] as SegmentTurn[] };
  const missing = last ? targetChars(i.minutes) - charsOf(s.segments.flat()) - charsOf(p.turns) : blockTarget(s, k) - charsOf(p.turns);
  const words = Math.max(120, Math.round(Math.max(600, missing) / CHARS_PER_SPOKEN_WORD));
  const name = (t: SegmentTurn) => `${t.speaker === "A" ? i.hostName : i.guestName}: ${t.text}`;
  const block = plan.segments[k];
  return [
    `Amplía el bloque ${k + 1} de ${n} («${block.title}») de un episodio de podcast en español latinoamericano de ${i.minutes} minutos: «${plan.title}». Quedó corto y le faltan unas ${words} palabras habladas.`,
    `Participantes (misma identidad, voz y personalidad):\n${people(i)}`,
    `Puntos de este bloque:\n${block.points.map((x) => `- ${x}`).join("\n")}`,
    `Así va el bloque (continúa EXACTAMENTE desde aquí, sin repetir ni resumir nada de lo dicho):\n${body.slice(-CONTEXT_TURNS).map(name).join("\n")}`,
    ...(closing.length ? [`Después de lo que escribas vendrá este cierre, que NO debes escribir: lleva la conversación hasta él con naturalidad:\n${closing.map(name).join("\n")}`] : []),
    `Escribe entre ${words} y ${Math.round(words * 1.15)} palabras más: profundiza los puntos con ejemplos, matices y réplicas; si un punto ya se trató, desarróllalo desde otro ángulo en vez de repetirlo.`,
    "Formato estricto: una línea por turno, «Nombre: texto», solo con los dos nombres de arriba. No saludes ni te despidas. Distingue afirmaciones, rumores y evidencia verificable; no inventes citas, cifras ni documentos.",
  ].join("\n\n");
}

/**
 * Avanza UN paso (escaleta, siguiente bloque o ampliación del bloque corto). Un error del proveedor se propaga tal
 * cual (el llamador lo traduce a un mensaje claro y recuperable); el estado recibido no cambia, así que reintentar
 * repite EXACTAMENTE la misma petición (misma clave: si ya se pagó, se reutiliza). Una respuesta inválida consume un
 * intento (o una ampliación) y lanza INVALIDO con el estado nuevo; nada de lo válido se pierde.
 */
export async function advanceLongScript(s: LongScriptState, llm: LlmStepFn): Promise<StepResult> {
  const n = segmentCount(s.input.minutes), steps = 1 + n;
  if (!s.plan) {
    const attempt = nextAttempt(s, "plan");
    const { text } = readOut(await llm(planPrompt(s.input), { step: `plan-a${attempt}`, maxTokens: PLAN_MAX_TOKENS }));
    const plan = parsePlan(text, n);
    const state = { ...s, attempts: { ...s.attempts, plan: attempt } };
    if (!plan) throw Object.assign(new LongScriptError("INVALIDO", "La escaleta del modelo no tenía el formato esperado; reintenta (no se perdió nada).", true), { state });
    return { state: { ...state, plan }, done: false, step: 1, steps, phase: "escaleta" };
  }
  const k = s.segments.length;
  if (k >= n) return { state: s, done: true, step: steps, steps, phase: "bloque" };
  const p = s.partial && s.partial.k === k ? s.partial : null;
  let turns: SegmentTurn[], attempt: number, ext: number, state: LongScriptState;
  if (!p) {
    const key = `s${k}`;
    attempt = nextAttempt(s, key); ext = 0;
    const target = blockTarget(s, k);
    const parsed = parseSegment(await llm(segmentPrompt(s, k), { step: `${key}-a${attempt}`, maxTokens: segmentMaxTokens(target) }), s.input);
    state = { ...s, attempts: { ...s.attempts, [key]: attempt }, partial: null };
    const issues = parsed ? segmentIssues(parsed.turns, s, k) : ["no es un diálogo con los dos participantes"];
    if (!parsed || issues.length) throw Object.assign(new LongScriptError("INVALIDO", `El bloque ${k + 1} de ${n} no cumplió los requisitos (${issues.join("; ")}); reintenta desde ahí (lo anterior se conserva).`, true), { state });
    turns = parsed.turns;
  } else if (p.ext >= MAX_EXTENSIONS_PER_BLOCK) {
    // Ampliaciones agotadas (p. ej. estado guardado por una versión anterior): se cierra con lo escrito SIN pagar otra.
    return commit({ ...s, partial: null }, k, p.turns, steps, `El bloque ${k + 1} quedó algo más corto de lo previsto; se conservó lo escrito.`);
  } else {
    attempt = p.attempt; ext = p.ext + 1;
    const parsed = parseSegment(await llm(extensionPrompt(s, p), { step: `s${k}-a${attempt}-x${ext}`, maxTokens: segmentMaxTokens(Math.max(1200, blockTarget(s, k) - charsOf(p.turns))) }), s.input);
    const last = k === n - 1;
    const issues = parsed ? segmentFormIssues(parsed.turns, s, k, { allowFarewell: false, before: p.turns }) : ["no es un diálogo con los dos participantes"];
    if (!parsed || !parsed.turns.length || issues.length) {
      // La ampliación no sirvió: se descarta ESA respuesta (lo escrito antes se conserva) y se gasta una ampliación.
      const kept = { ...s, partial: { ...p, ext } };
      if (ext < MAX_EXTENSIONS_PER_BLOCK) throw Object.assign(new LongScriptError("INVALIDO", `La ampliación del bloque ${k + 1} no sirvió (${issues.join("; ")}); reintenta (lo escrito se conserva).`, true), { state: kept });
      return commit(kept, k, p.turns, steps, `El bloque ${k + 1} quedó algo más corto de lo previsto; se conservó lo escrito.`);
    }
    const { body, closing } = last ? splitClosing(p.turns) : { body: p.turns, closing: [] as SegmentTurn[] };
    turns = [...body, ...parsed.turns, ...closing];
    state = { ...s, partial: null };
  }
  const verdict = blockVerdict(state, k, turns, ext);
  if (verdict === "ampliar") {
    return { state: { ...state, partial: { k, attempt, ext, turns } }, done: false, step: 1 + k, steps, phase: "ampliando",
      note: `El bloque ${k + 1} de ${n} quedó corto (${charsOf(turns)} de ${blockTarget(state, k)} caracteres); se amplía sin repetir lo escrito.` };
  }
  return commit(state, k, turns, steps, verdict === "compensar" ? `El bloque ${k + 1} quedó algo corto; los siguientes lo compensan.` : verdict === "conservar" ? `El bloque ${k + 1} quedó algo más corto de lo previsto; se conservó lo escrito.` : undefined);
}

function commit(s: LongScriptState, k: number, turns: SegmentTurn[], steps: number, note?: string): StepResult {
  const next = { ...s, partial: null, segments: [...s.segments, turns] };
  return { state: next, done: next.segments.length === steps - 1, step: 2 + k, steps, phase: "bloque", ...(note ? { note } : {}) };
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
  // Un bloque que absorbió el déficit de otro o fue ampliado puede medir hasta ABSORB_MAX × máx. del rango.
  const limit = segmentChars(input.minutes) * ABSORB_MAX * SEGMENT_RANGE.max * 1.2;
  for (const seg of s.segments) {
    if (!Array.isArray(seg) || !seg.length || seg.length > 300) throw bad("segmento");
    let c = 0;
    for (const t of seg) { if ((t?.speaker !== "A" && t?.speaker !== "B") || typeof t.text !== "string") throw bad("turno"); c += t.text.length; }
    if (c > limit) throw bad("segmento demasiado largo");
  }
  const attempts: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.attempts ?? {})) if (/^(plan|s\d{1,2})$/.test(k) && Number.isInteger(v) && v >= 0 && v <= MAX_ATTEMPTS_PER_STEP) attempts[k] = v;
  let partial: LongScriptState["partial"] = null;
  if (s.partial != null) {
    const q = s.partial;
    if (!s.plan || typeof q !== "object" || q.k !== s.segments.length || !Number.isInteger(q.attempt) || q.attempt < 1 || q.attempt > MAX_ATTEMPTS_PER_STEP
      // ext 0–1: ampliación pendiente. ext = 2 (tope alcanzado, p. ej. guardado por una versión anterior): se admite y el
      // motor cierra el bloque con lo escrito SIN llamar al modelo; así no se pierde el ancla (mismo jobId). ext > 2: manipulado.
      || !Number.isInteger(q.ext) || q.ext < 0 || q.ext > MAX_EXTENSIONS_PER_BLOCK || !Array.isArray(q.turns) || !q.turns.length || q.turns.length > 300) throw bad("bloque en ampliación");
    let c = 0;
    for (const t of q.turns) { if ((t?.speaker !== "A" && t?.speaker !== "B") || typeof t.text !== "string") throw bad("turno"); c += t.text.length; }
    if (c > limit) throw bad("bloque en ampliación demasiado largo");
    partial = { k: q.k, attempt: q.attempt, ext: q.ext, turns: q.turns.map((t) => ({ speaker: t.speaker, text: t.text.replace(/\s+/g, " ").trim() })) };
  }
  // El intento del bloque en ampliación es el que se pagó para ese bloque (misma clave «s<k>-a<n>»), no otro.
  if (partial && attempts[`s${partial.k}`] !== partial.attempt) throw bad("intento del bloque en ampliación");
  const plan = s.plan ? { title: String(s.plan.title ?? "").slice(0, 160), segments: s.plan.segments.map((b) => ({ title: String(b?.title ?? "").slice(0, 160), points: (Array.isArray(b?.points) ? b.points : []).slice(0, 10).map((p) => String(p).slice(0, 300)) })) } : null;
  return { v: 1, jobId: s.jobId.toLowerCase(), input, plan, segments: s.segments.map((seg) => seg.map((t) => ({ speaker: t.speaker, text: t.text.replace(/\s+/g, " ").trim() }))), attempts, partial };
}
