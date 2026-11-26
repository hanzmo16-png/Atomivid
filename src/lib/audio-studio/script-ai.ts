/**
 * Guion con IA de Audio Podcast Studio (P0 2026-11-25). Antes, «Generar estructura de guion» dejaba una plantilla con
 * pautas («Desarrolla esta idea… (Reemplaza esta pauta por unas 300 palabras.)») que la persona debía rellenar, y si no
 * lo hacía esas pautas se narraban. Ahora la IA escribe el episodio COMPLETO a partir del tema (título), las notas de
 * dirección, la duración, el idioma y las voces elegidas:
 *
 *  1. ESCALETA: una llamada planifica N bloques temáticos (≈10 min cada uno) con puntos concretos del tema.
 *  2. BLOQUES: una llamada por bloque escribe el texto que se va a NARRAR (monólogo, o «Voz 1:» / «Voz 2:»), con la
 *     escaleta completa, lo ya cubierto y el final del bloque anterior como contexto. Cada bloque se limpia y se valida.
 *  3. ENSAMBLAJE: títulos «## …» (no se narran) + texto; duración estimada frente a la pedida.
 *
 * Cada paso es UNA petición HTTP: el estado se guarda en el proyecto entre pasos (progreso real y reanudable). Las
 * llamadas pagadas usan una clave determinista por trabajo, paso e intento (libro de gastos): repetir un paso
 * reutiliza lo ya pagado y nunca cobra dos veces. Nunca se sustituye por una plantilla.
 *
 * Puro: sin red ni disco; el modelo se inyecta (simulado en pruebas).
 */
import { WORDS_PER_MINUTE, wordCount, type StudioLanguage } from "./model";

export const BLOCK_MINUTES = 10;
/** Hasta aquí, escaleta + un único bloque. */
export const SINGLE_BLOCK_MAX_MINUTES = 12;
export const MAX_ATTEMPTS_PER_STEP = 3;
/** Un bloque por debajo de esto (frente a su objetivo) no sirve; por encima de MAX, tampoco. */
export const BLOCK_RANGE = { hardMin: 0.45, max: 1.6 } as const;
/** Duración total aceptada frente a la pedida. */
export const TOTAL_RANGE = { min: 0.85, max: 1.2 } as const;
export const PLAN_MAX_TOKENS = 2500;
/** Un trabajo «en curso» sin actividad durante esto se muestra como interrumpido (se puede continuar). */
export const SCRIPT_STALE_MS = 6 * 60_000;

export type ScriptAiInput = { topic: string; notes: string; minutes: number; voiceCount: 1 | 2; language: StudioLanguage; voiceNames: string[] };
export type ScriptPlan = { title: string; blocks: { title: string; points: string[] }[] };
export type ScriptJobStatus = "en_curso" | "terminado" | "fallido" | "cancelado";
export type ScriptJob = {
  v: 1; jobId: string; input: ScriptAiInput; status: ScriptJobStatus;
  plan: ScriptPlan | null;
  /** Texto narrable de cada bloque terminado (líneas; con dos voces cada una empieza por «Voz N:»). */
  blocks: string[][];
  attempts: Record<string, number>;
  error: string | null; note: string | null;
  startedAt: string; updatedAt: string; finishedAt: string | null;
  /** Al terminar: duración estimada del guion escrito y si cae en el rango pedido. */
  result: { words: number; estimatedMinutes: number; withinTarget: boolean } | null;
};
export type LlmOut = string | { text: string; stopReason?: string | null };
export type LlmStepFn = (prompt: string, o: { step: string; maxTokens: number }) => Promise<LlmOut>;
export type StepReplayFn = (step: string) => Promise<LlmOut | null>;

export class ScriptAiError extends Error {
  constructor(readonly code: "INVALIDO" | "AGOTADO" | "ESTADO", message: string, readonly recoverable: boolean, readonly job?: ScriptJob) { super(message); this.name = "ScriptAiError"; }
}

export const blockCount = (minutes: number) => (minutes <= SINGLE_BLOCK_MAX_MINUTES ? 1 : Math.ceil(minutes / BLOCK_MINUTES));
export const totalSteps = (j: Pick<ScriptJob, "input">) => 1 + blockCount(j.input.minutes);
export const stepsDone = (j: Pick<ScriptJob, "plan" | "blocks">) => (j.plan ? 1 : 0) + j.blocks.length;
export const targetWords = (minutes: number) => Math.round(minutes * WORDS_PER_MINUTE);
const wordsOf = (lines: string[]) => lines.reduce((n, l) => n + wordCount(stripSpeaker(l)), 0);

/** Objetivo del bloque `k`: lo que falta repartido entre los bloques que quedan (uno corto lo compensan los siguientes). */
export function blockTargetWords(j: Pick<ScriptJob, "input" | "blocks" | "plan">, k: number): number {
  const n = j.plan?.blocks.length ?? blockCount(j.input.minutes), base = targetWords(j.input.minutes) / n;
  const remaining = Math.max(0, targetWords(j.input.minutes) - wordsOf(j.blocks.flat()));
  return Math.round(Math.min(base * 1.4, Math.max(base * 0.6, remaining / Math.max(1, n - k))));
}
/** Tokens de salida: ~1,4 tokens por palabra en español/inglés, con holgura para el tope del rango. */
const blockMaxTokens = (words: number) => Math.min(16000, Math.ceil(words * 1.4 * BLOCK_RANGE.max) + 400);

export function newScriptJob(jobId: string, input: ScriptAiInput, now: string): ScriptJob {
  return { v: 1, jobId, input, status: "en_curso", plan: null, blocks: [], attempts: {}, error: null, note: null, startedAt: now, updatedAt: now, finishedAt: null, result: null };
}

// ── Texto que NUNCA debe narrarse ───────────────────────────────────────────────────────────────────────────────────
/**
 * Marcadores de plantilla e instrucciones internas. Se comprueban en cada bloque escrito por la IA y, antes de gastar
 * en voz, en TODO guion (también el escrito o pegado a mano): si aparecen, «Generar MP3» queda bloqueado con el motivo.
 */
const INSTRUCTION_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\breempla(?:za|zar|ce)\b[^.\n]{0,60}\b(?:pauta|texto|guion|esta)/i, why: "una pauta para reemplazar" },
  { re: /\breplace (?:this|the)\b/i, why: "una pauta para reemplazar" },
  { re: /\b(?:pauta|placeholder|lorem ipsum|marcador de posici[oó]n)\b/i, why: "un marcador de plantilla" },
  { re: /\bunas?\s+\d{2,5}\s+palabras\b|\babout \d{2,5} words\b/i, why: "una indicación de extensión" },
  { re: /\b(?:desarrolla|completa|escribe|rellena|a[nñ]ade)\s+(?:aqu[ií]|esta idea|este punto|tu (?:texto|guion))\b/i, why: "una instrucción para quien escribe" },
  { re: /\b(?:develop this idea|write (?:your|the) script|add a question or another perspective)\b/i, why: "una instrucción para quien escribe" },
  { re: /\b(?:responde, pregunta o a[nñ]ade un matiz|presenta «)/i, why: "una pauta de la plantilla anterior" },
  { re: /\bnotas? de direcci[oó]n\b|\bdirection notes?\b|\binstrucciones?\s*:/i, why: "texto de las notas de dirección" },
  { re: /\b(?:TODO|TBD|XXX)\b/, why: "un marcador pendiente" },
  { re: /\[[^\]\n]{0,80}\]|\{[^}\n]{0,80}\}|<[^>\n]{0,80}>/, why: "un marcador entre corchetes" },
  { re: /^\s*(?:[-*•]\s|\d+[.)]\s)/m, why: "una lista con viñetas" },
  { re: /\*\*|__|`/, why: "formato markdown" },
  { re: /\((?:m[uú]sica|risas?|pausa|sonido|efecto|cortinilla|aplausos|silencio|intro|outro|music|laughs?|pause|sfx)[^)\n]{0,60}\)/i, why: "una acotación de producción" },
  { re: /^\s*(?:narrador|locutor|host|presentador|anfitri[oó]n|invitad[oa]|voz\s*[3-9]|voice\s*[3-9])\s*:/im, why: "una etiqueta de voz no válida" },
];

/** Línea → texto narrado (sin «Voz N:», que el estudio no lee en voz alta). */
export const stripSpeaker = (l: string) => l.replace(/^\s*(?:(?:voz|voice)\s*[12]|\[[12]\])\s*[:\-—]\s*/i, "");

/** Defectos de un guion que harían narrar instrucciones o marcadores (vacío = se puede narrar). Ignora títulos «## …». */
export function narrationIssues(script: string): string[] {
  const out = new Set<string>();
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (!line || /^#{1,3}\s+/.test(line)) continue;
    for (const p of INSTRUCTION_PATTERNS) {
      const text = p.why === "una etiqueta de voz no válida" || p.why === "una lista con viñetas" ? line : stripSpeaker(line);
      if (p.re.test(text)) out.add(`El guion contiene ${p.why} que se narraría: «${line.slice(0, 70)}${line.length > 70 ? "…" : ""}». Quítalo antes de generar el audio.`);
    }
  }
  return [...out].slice(0, 3);
}

/**
 * Limpieza segura de lo que el modelo a veces añade y no es habla: negritas, comillas de bloque, acotaciones de
 * producción entre paréntesis o asteriscos y líneas de título. No inventa ni reescribe contenido.
 */
export function cleanBlockText(text: string): string[] {
  const lines: string[] = [];
  for (let l of text.replace(/^```\w*$|^```$/gm, "").split("\n")) {
    l = l.replace(/\*\*|__/g, "").replace(/^\s*>\s?/, "").trim();
    if (!l || /^#{1,6}\s/.test(l)) continue;
    l = l.replace(/\((?:m[uú]sica|risas?|pausa|sonido|efecto|cortinilla|aplausos|silencio|intro|outro|music|laughs?|pause|sfx)[^)]{0,60}\)/gi, "")
      .replace(/\*[^*\n]{1,60}\*/g, "").replace(/\s{2,}/g, " ").trim();
    // «VOZ 1 —», «Voice 2 -», «[1]:» → «Voz 1:» / «Voice 1:» (una sola forma).
    l = l.replace(/^(?:\s*(?:voz|voice)\s*([12])|\s*\[([12])\])\s*[:\-—]\s*/i, (_m, a, b) => `Voz ${a ?? b}: `);
    if (stripSpeaker(l).trim()) lines.push(l);
  }
  return lines;
}

// ── Prompts ────────────────────────────────────────────────────────────────────────────────────────────────────────
const lang = (i: ScriptAiInput) => (i.language === "en" ? "inglés (en el texto narrado)" : "español latinoamericano");
const format = (i: ScriptAiInput) => i.voiceCount === 2
  ? `una conversación natural entre dos voces: Voz 1 (se llama ${i.voiceNames[0] ?? "Voz 1"}) y Voz 2 (se llama ${i.voiceNames[1] ?? "Voz 2"})`
  : `un monólogo narrado por una sola voz (se llama ${i.voiceNames[0] ?? "la voz"})`;
const notesBlock = (i: ScriptAiInput) => i.notes.trim()
  ? `Notas de dirección del cliente (OBLIGATORIAS: tono, enfoque, público, estilo y lo que pida; no las cites ni las leas en voz alta):\n«${i.notes.trim()}»`
  : "Sin notas de dirección: tono divulgativo, cercano y riguroso.";

export function planPrompt(i: ScriptAiInput): string {
  const n = blockCount(i.minutes);
  return [
    `Planifica un episodio de podcast SOLO AUDIO en ${lang(i)} de ${i.minutes} minutos: ${format(i)}.`,
    `Tema del episodio:\n«${i.topic}»`,
    notesBlock(i),
    `Divide el episodio en exactamente ${n} ${n === 1 ? "bloque" : "bloques consecutivos"} de unos ${Math.round(i.minutes / n)} minutos, con un arco claro: apertura que engancha, desarrollo que avanza sin repetirse y cierre con conclusión.`,
    "Los puntos deben ser ESPECÍFICOS del tema (lugares, fechas, personas, hallazgos, hipótesis, debates), no genéricos. Cada punto aparece una sola vez. Distingue hechos comprobados, hipótesis y afirmaciones sin verificar; no inventes citas, cifras ni documentos.",
    `Responde SOLO con JSON válido, sin texto adicional:\n{"titulo":"…","bloques":[{"titulo":"…","puntos":["…","…","…","…"]}]}\nEl arreglo "bloques" tiene exactamente ${n} elementos y cada uno entre 4 y 8 puntos.`,
  ].join("\n\n");
}

export function parsePlan(text: string, n: number): ScriptPlan | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let raw: unknown;
  try { raw = JSON.parse(m[0]); } catch { return null; }
  const o = raw as { titulo?: unknown; title?: unknown; bloques?: unknown; blocks?: unknown };
  const list = (Array.isArray(o.bloques) ? o.bloques : Array.isArray(o.blocks) ? o.blocks : null) as { titulo?: unknown; title?: unknown; puntos?: unknown; points?: unknown }[] | null;
  if (!list || list.length !== n) return null;
  const blocks: ScriptPlan["blocks"] = [];
  for (const b of list) {
    const title = String(b?.titulo ?? b?.title ?? "").replace(/[#*`]/g, "").trim().slice(0, 120);
    const rawPoints = Array.isArray(b?.puntos) ? b.puntos : Array.isArray(b?.points) ? b.points : [];
    const points = rawPoints.map((p) => String(p ?? "").trim().slice(0, 300)).filter(Boolean).slice(0, 10);
    if (!title || points.length < 2) return null;
    blocks.push({ title, points });
  }
  return { title: String(o.titulo ?? o.title ?? "").replace(/[#*`]/g, "").trim().slice(0, 160) || blocks[0].title, blocks };
}

const CONTEXT_LINES = 6;
export function blockPrompt(j: ScriptJob, k: number): string {
  const i = j.input, plan = j.plan!, n = plan.blocks.length, words = blockTargetWords(j, k);
  const outline = plan.blocks.map((b, x) => `${x + 1}. ${b.title}${x < k ? " (ya cubierto)" : x === k ? " ← ESTE BLOQUE" : ""}\n${b.points.map((p) => `   - ${p}`).join("\n")}`).join("\n");
  const prev = j.blocks.flat().slice(-CONTEXT_LINES).join("\n");
  const first = k === 0, last = k === n - 1;
  return [
    `Escribe el bloque ${k + 1} de ${n} de un episodio de podcast SOLO AUDIO en ${lang(i)} de ${i.minutes} minutos titulado «${plan.title}»: ${format(i)}.`,
    `Tema del episodio:\n«${i.topic}»`,
    notesBlock(i),
    `Escaleta completa:\n${outline}`,
    ...(prev ? [`Así terminó el bloque anterior (solo contexto: NO lo copies ni lo parafrasees; continúa desde ahí):\n${prev}`] : []),
    `Extensión de ESTE bloque: entre ${words} y ${Math.round(words * 1.15)} palabras habladas (unos ${Math.max(1, Math.round(words / WORDS_PER_MINUTE))} minutos de audio). La extensión se cumple con contenido (datos, ejemplos, contexto, matices), nunca con relleno ni repeticiones.`,
    [
      "Reglas (el texto se convierte directamente en voz; TODO lo que escribas se va a narrar):",
      i.voiceCount === 2
        ? "- Una línea por intervención, empezando EXACTAMENTE por «Voz 1:» o «Voz 2:». Solo esas dos etiquetas. Diálogo natural: preguntas, respuestas, réplicas; nadie habla más de tres intervenciones seguidas."
        : "- Párrafos de texto corrido, sin etiquetas de voz ni nombres delante.",
      "- Sin títulos, viñetas, listas numeradas, markdown, corchetes, acotaciones entre paréntesis, indicaciones de música o efectos, ni instrucciones. Solo lo que se dice en voz alta.",
      "- Cubre los puntos de ESTE bloque en orden lógico; no adelantes los siguientes ni repitas lo ya cubierto.",
      "- Distingue hechos comprobados, hipótesis y afirmaciones sin verificar; dilo cuando algo no está comprobado. No inventes citas textuales, cifras ni documentos.",
      first ? "- Empieza presentando el episodio y su tema." : "- NO saludes ni presentes el programa de nuevo: estamos a mitad de episodio.",
      last ? "- Termina con una conclusión clara y la despedida del episodio." : "- NO te despidas: termina con una transición natural hacia el siguiente bloque.",
    ].join("\n"),
  ].join("\n\n");
}

// ── Validación de un bloque ────────────────────────────────────────────────────────────────────────────────────────
const GREETING = /\b(bienvenid[oa]s?|hola a todos|hola,? (amigos|oyentes)|welcome to|hello everyone)\b/i;
const FAREWELL = /\b(hasta la pr[oó]xima|gracias por (escucharnos|escuchar|acompa[nñ]arnos)|nos despedimos|hasta el pr[oó]ximo episodio|thanks for listening|see you next time|until next time)\b/i;
const norm = (t: string) => stripSpeaker(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]/g, "").replace(/\s+/g, " ").trim();

export function blockIssues(lines: string[], j: ScriptJob, k: number): string[] {
  const n = j.plan!.blocks.length, target = blockTargetWords(j, k), words = wordsOf(lines);
  const out: string[] = [];
  if (!lines.length) return ["respuesta vacía"];
  if (words < target * BLOCK_RANGE.hardMin) out.push(`demasiado corto: ${words} de ${target} palabras`);
  if (words > target * BLOCK_RANGE.max) out.push(`demasiado largo: ${words} de ${target} palabras`);
  if (j.input.voiceCount === 2) {
    const labelled = lines.filter((l) => /^Voz [12]: /.test(l));
    if (labelled.length < lines.length * 0.9) out.push("no todas las intervenciones empiezan por «Voz 1:» o «Voz 2:»");
    const v2 = labelled.filter((l) => l.startsWith("Voz 2:")).length;
    if (v2 < 2 || labelled.length - v2 < 2) out.push("no es un diálogo entre las dos voces");
  } else if (lines.some((l) => /^Voz [12]: /.test(l))) {
    out.push("lleva etiquetas de voz en un monólogo");
  }
  const issues = narrationIssues(lines.join("\n"));
  if (issues.length) out.push("contiene instrucciones o marcadores que se narrarían");
  const seen = new Set(j.blocks.flat().map(norm).filter((t) => t.length >= 40));
  const repeated = lines.filter((l) => { const x = norm(l); return x.length >= 40 && seen.has(x); }).length;
  if (repeated) out.push(`${repeated} intervenciones repetidas de lo ya escrito`);
  if (k > 0 && lines.slice(0, 2).some((l) => GREETING.test(l))) out.push("vuelve a saludar a mitad de episodio");
  if (k < n - 1 && lines.slice(-2).some((l) => FAREWELL.test(l))) out.push("se despide antes del final");
  return out;
}

const readText = (o: LlmOut) => (typeof o === "string" ? o : String(o?.text ?? ""));
const truncated = (o: LlmOut) => typeof o !== "string" && o?.stopReason === "max_tokens";

function nextAttempt(j: ScriptJob, key: string, label: string): number {
  const used = j.attempts[key] ?? 0;
  if (used >= MAX_ATTEMPTS_PER_STEP) {
    throw new ScriptAiError("AGOTADO", `La IA no logró ${label} válido tras ${MAX_ATTEMPTS_PER_STEP} intentos. No se usó ninguna plantilla y tu guion anterior no se tocó; puedes volver a intentarlo.`, false,
      { ...j, status: "fallido", error: `La IA no logró ${label} válido.` });
  }
  return used + 1;
}

export type StepOutcome = { job: ScriptJob; done: boolean; phase: "escaleta" | "bloque" };

/**
 * Avanza UN paso (escaleta o siguiente bloque). Un error del proveedor se propaga tal cual (el trabajo no cambia:
 * reintentar repite la misma clave y, si ya se pagó, se reutiliza). Una respuesta inválida consume un intento y lanza
 * INVALIDO con el trabajo actualizado; nada de lo válido se pierde.
 */
export async function advanceScriptJob(j: ScriptJob, llm: LlmStepFn, now: string, replay?: StepReplayFn): Promise<StepOutcome> {
  if (j.status !== "en_curso") throw new ScriptAiError("ESTADO", "Este guion con IA ya no está en curso.", false, j);
  const n = blockCount(j.input.minutes);
  if (!j.plan) {
    const attempt = nextAttempt(j, "plan", "una escaleta");
    const text = readText(await llm(planPrompt(j.input), { step: `plan-a${attempt}`, maxTokens: PLAN_MAX_TOKENS }));
    const plan = parsePlan(text, n);
    const next = { ...j, attempts: { ...j.attempts, plan: attempt }, updatedAt: now };
    if (!plan) throw new ScriptAiError("INVALIDO", "La escaleta de la IA no tenía el formato esperado; se reintenta (no se perdió nada).", true, { ...next, error: null });
    return { job: { ...next, plan, error: null, note: null }, done: false, phase: "escaleta" };
  }
  const k = j.blocks.length;
  const key = `b${k}`;
  let lines: string[] | null = null, attempt = j.attempts[key] ?? 0;
  // Antes de pagar otro intento, los ya pagados de este bloque se reevalúan gratis con las reglas vigentes.
  if (replay) {
    for (let a = 1; a <= attempt && !lines; a++) {
      const out = await replay(`${key}-a${a}`).catch(() => null);
      if (!out) continue;
      const c = cleanBlockText(readText(out));
      if (truncated(out) && c.length > 1) c.pop();
      if (!blockIssues(c, j, k).length) lines = c;
    }
  }
  let next = j;
  if (!lines) {
    attempt = nextAttempt(j, key, `el bloque ${k + 1} de ${n}`);
    const out = await llm(blockPrompt(j, k), { step: `${key}-a${attempt}`, maxTokens: blockMaxTokens(blockTargetWords(j, k)) });
    const c = cleanBlockText(readText(out));
    if (truncated(out) && c.length > 1) c.pop();
    next = { ...j, attempts: { ...j.attempts, [key]: attempt }, updatedAt: now };
    const issues = blockIssues(c, next, k);
    if (issues.length) throw new ScriptAiError("INVALIDO", `El bloque ${k + 1} de ${n} no cumplió los requisitos (${issues.join("; ")}); se reintenta desde ahí (lo anterior se conserva).`, true, { ...next, error: null });
    lines = c;
  }
  const blocks = [...next.blocks, lines];
  const done = blocks.length === n;
  const job: ScriptJob = { ...next, blocks, updatedAt: now, error: null, note: null };
  if (!done) return { job, done, phase: "bloque" };
  const words = wordsOf(blocks.flat()), estimatedMinutes = Math.round((words / WORDS_PER_MINUTE) * 10) / 10, ratio = estimatedMinutes / j.input.minutes;
  return { job: { ...job, status: "terminado", finishedAt: now, result: { words, estimatedMinutes, withinTarget: ratio >= TOTAL_RANGE.min && ratio <= TOTAL_RANGE.max } }, done, phase: "bloque" };
}

/** Guion final del trabajo terminado: «## título del bloque» (no se narra) y el texto de cada bloque. */
export function assembleScript(j: ScriptJob): string {
  if (!j.plan) return "";
  return j.plan.blocks.map((b, x) => [`## ${b.title}`, ...(j.blocks[x] ?? [])].join("\n\n")).join("\n\n");
}

/** Lectura defensiva de un trabajo guardado en el proyecto (null si no hay o no es válido). */
export function parseScriptJob(x: unknown): ScriptJob | null {
  const j = x as ScriptJob;
  if (!j || typeof j !== "object" || j.v !== 1 || typeof j.jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(j.jobId)) return null;
  const i = j.input as ScriptAiInput;
  if (!i || typeof i.topic !== "string" || typeof i.minutes !== "number" || (i.voiceCount !== 1 && i.voiceCount !== 2) || (i.language !== "es" && i.language !== "en")) return null;
  if (!["en_curso", "terminado", "fallido", "cancelado"].includes(j.status)) return null;
  const n = blockCount(i.minutes);
  const plan = j.plan && Array.isArray(j.plan.blocks) && j.plan.blocks.length === n
    ? { title: String(j.plan.title ?? "").slice(0, 160), blocks: j.plan.blocks.map((b) => ({ title: String(b?.title ?? "").slice(0, 120), points: (Array.isArray(b?.points) ? b.points : []).slice(0, 10).map((p) => String(p).slice(0, 300)) })) }
    : null;
  const blocks = plan && Array.isArray(j.blocks) ? j.blocks.slice(0, n).filter(Array.isArray).map((b) => b.slice(0, 400).map((l) => String(l).slice(0, 4000))) : [];
  const attempts: Record<string, number> = {};
  for (const [k, v] of Object.entries(j.attempts ?? {})) if (/^(plan|b\d{1,2})$/.test(k) && Number.isInteger(v) && v >= 0 && v <= MAX_ATTEMPTS_PER_STEP) attempts[k] = v;
  const r = j.result;
  return {
    v: 1, jobId: j.jobId.toLowerCase(), status: j.status, plan, blocks, attempts,
    input: { topic: i.topic.slice(0, 300), notes: String(i.notes ?? "").slice(0, 2000), minutes: i.minutes, voiceCount: i.voiceCount, language: i.language, voiceNames: (Array.isArray(i.voiceNames) ? i.voiceNames : []).slice(0, 2).map((s) => String(s).slice(0, 40)) },
    error: typeof j.error === "string" ? j.error.slice(0, 500) : null, note: typeof j.note === "string" ? j.note.slice(0, 500) : null,
    startedAt: String(j.startedAt ?? ""), updatedAt: String(j.updatedAt ?? ""), finishedAt: typeof j.finishedAt === "string" ? j.finishedAt : null,
    result: r && typeof r === "object" && typeof r.words === "number" ? { words: r.words, estimatedMinutes: Number(r.estimatedMinutes) || 0, withinTarget: !!r.withinTarget } : null,
  };
}

export const scriptJobActive = (j: ScriptJob | null | undefined) => j?.status === "en_curso";
export const scriptJobStale = (j: ScriptJob | null | undefined, now: number) => !!j && j.status === "en_curso" && now - Date.parse(j.updatedAt) > SCRIPT_STALE_MS;
