/**
 * Podcast 3.0 — guion. Tres entradas:
 *  1) guion pegado con etiquetas de hablante («Nombre:», «A:», «[B]», «— Ana:») → turnos;
 *  2) texto narrativo sin etiquetas → turnos por párrafo (modo A/B);
 *  3) solo un tema → generador conversacional: ruta LLM inyectable (en la app, el mismo cliente protegido por el
 *     libro de gastos; en pruebas, simulado) con respaldo DETERMINISTA por plantillas si no hay LLM o falla.
 */
export type Speaker = "A" | "B";
export type Turn = { id: string; speaker: Speaker; text: string; kind: TurnKind };
export type TurnKind = "pregunta" | "respuesta" | "comentario" | "reaccion" | "narracion" | "apertura" | "cierre" | "desacuerdo" | "transicion";

export const turnId = (i: number) => `T${String(i + 1).padStart(3, "0")}`;

export function classifyTurn(text: string, i: number, n: number): TurnKind {
  const t = text.trim();
  if (i === 0) return "apertura";
  if (i === n - 1) return "cierre";
  if (/^(no estoy de acuerdo|discrepo|no del todo|yo no (lo )?dir[ií]a|perdona,? pero|no creo que)/i.test(t)) return "desacuerdo";
  if (/^(volviendo a|pasemos a|cambiando de tema|y otra cosa|hablemos ahora)/i.test(t)) return "transicion";
  if (/[?¿]/.test(t)) return "pregunta";
  if (t.length < 40 && /^(¡|wow|vaya|increíble|claro|exacto|no puede ser|qué|ja)/i.test(t)) return "reaccion";
  return t.length > 160 ? "respuesta" : "comentario";
}

const LABEL = /^\s*(?:[-—–]\s*)?(?:\[([^\]]{1,40})\]|([A-Za-zÁÉÍÓÚÑáéíóúñü][\wÁÉÍÓÚÑáéíóúñü .'-]{0,39}?))\s*:\s*(.+)$/;

/**
 * Parsea un guion con etiquetas. Las dos primeras etiquetas distintas son A y B (o los nombres dados).
 * Devuelve null si no hay al menos dos líneas etiquetadas (no es un diálogo).
 */
export function parseLabeledScript(text: string, names?: { A?: string; B?: string }): { turns: Turn[]; labels: Record<Speaker, string> } | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const raw: { label: string; text: string }[] = [];
  for (const line of lines) {
    const m = LABEL.exec(line);
    if (m && !/^https?$/i.test((m[1] ?? m[2] ?? "").trim())) raw.push({ label: (m[1] ?? m[2]).trim(), text: m[3].trim() });
    else if (line.trim() && raw.length) raw[raw.length - 1].text += " " + line.trim();
  }
  if (raw.length < 2) return null;
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const order: string[] = [];
  for (const r of raw) if (!order.includes(norm(r.label))) order.push(norm(r.label));
  if (order.length > 2) return null;
  const mapFor = (lab: string): Speaker => {
    const n = norm(lab);
    if (names?.A && norm(names.A) === n) return "A";
    if (names?.B && norm(names.B) === n) return "B";
    if (n === "a") return "A"; if (n === "b") return "B";
    return order.indexOf(n) === 0 ? "A" : "B";
  };
  const labels: Record<Speaker, string> = { A: names?.A ?? "A", B: names?.B ?? "B" };
  for (const r of raw) { const s = mapFor(r.label); if (!names?.[s] && r.label.length > 1) labels[s] = r.label; }
  const turns = raw.map((r, i) => ({ id: turnId(i), speaker: mapFor(r.label), text: r.text.replace(/\s+/g, " ").trim(), kind: classifyTurn(r.text, i, raw.length) }));
  return { turns, labels };
}

/** Máximo de palabras por segmento de narración: cada segmento lleva su propio plano (imagen o transición). */
export const NARRATION_SEGMENT_WORDS = 40;

/** Párrafo → segmentos de oraciones completas de ≤ NARRATION_SEGMENT_WORDS palabras (una oración más larga queda sola). */
export function narrationSegments(paragraph: string, maxWords = NARRATION_SEGMENT_WORDS): string[] {
  const sentences = paragraph.match(/[^.!?…]+(?:[.!?…]+["»”)]*|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [paragraph];
  const out: string[] = []; let cur = "";
  const words = (x: string) => x.split(/\s+/).filter(Boolean).length;
  for (const st of sentences) { if (cur && words(cur) + words(st) > maxWords) { out.push(cur); cur = st; } else cur = cur ? `${cur} ${st}` : st; }
  if (cur) out.push(cur);
  return out;
}

/**
 * Narración: párrafos → turnos; un párrafo largo se divide en segmentos de oraciones completas para que cada parte tenga
 * su propio plano (antes, un párrafo de un minuto quedaba con una sola imagen). Con dos voces, alterna por párrafo (A, B, A…).
 */
export function narrationTurns(text: string, voices: 1 | 2): Turn[] {
  const paras = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const turns: Turn[] = [];
  paras.forEach((p, i) => { for (const seg of narrationSegments(p)) turns.push({ id: turnId(turns.length), speaker: voices === 2 && i % 2 === 1 ? "B" : "A", text: seg, kind: "narracion" as const }); });
  return turns;
}

export type LlmFn = (prompt: string) => Promise<string>;
export type GenerateInput = { topic: string; hostName: string; guestName: string; guestRole?: string; minutes: number; language?: "es" | "en"; hostPersonality?: string; guestPersonality?: string };

/** ~150 palabras habladas por minuto; turnos de 25–60 palabras. */
export const WORDS_PER_MINUTE = 150;

export function conversationPrompt(i: GenerateInput): string {
  return [
    `Escribe un guion de podcast en español latinoamericano sobre: «${i.topic}».`,
    `Participantes: ${i.hostName} (anfitrión) y ${i.guestName}${i.guestRole ? ` (${i.guestRole})` : ""}.`,
    `Duración aproximada: ${i.minutes} minutos (~${i.minutes * WORDS_PER_MINUTE} palabras).`,
    ...(i.hostPersonality || i.guestPersonality ? [`Personalidades: ${i.hostName}: ${i.hostPersonality || "neutral"}; ${i.guestName}: ${i.guestPersonality || "neutral"}.`] : []),
    "Formato estricto: una línea por turno, «Nombre: texto». Alterna preguntas, respuestas, comentarios, reacciones breves, al menos un desacuerdo razonado y transiciones entre bloques.",
    "Coherencia: cada turno responde al anterior. No inventes citas ni datos verificables; si algo es especulación, dilo.",
    "Abre con una presentación y cierra con una despedida.",
  ].join("\n");
}

/** Respaldo determinista (sin red, sin costo): estructura de entrevista coherente con el tema. */
export function templateConversation(i: GenerateInput): Turn[] {
  const t = i.topic.trim().replace(/[.。]+$/, "") || "nuestro tema";
  const H = i.hostName, G = i.guestName;
  const opening: [Speaker, string][] = [
    ["A", `Bienvenidos a un nuevo episodio. Hoy hablamos de ${t}, y me acompaña ${G}${i.guestRole ? `, ${i.guestRole}` : ""}. ¡Gracias por venir!`],
    ["B", `Gracias a ti, ${H}. Es un tema que me apasiona y que mucha gente entiende a medias.`],
  ];
  const blocks: [Speaker, string][][] = [
    [["A", `Empecemos por lo básico: ¿qué es lo primero que alguien debería saber sobre ${t}?`],
     ["B", `Que no es tan simple como parece. Hay hechos documentados y hay mucha especulación alrededor; conviene separarlos desde el principio.`],
     ["A", "Interesante. Esa distinción entre lo comprobado y lo que se supone es clave."],
     ["B", "No del todo: a veces lo que se supone también merece atención, siempre que se diga que es una hipótesis."],
     ["A", "Discrepo un poco, pero acepto el matiz: lo importante es no venderlo como un hecho."]],
    [["A", `Pasemos a la historia. ¿Cuál fue el momento que cambió la forma en que entendemos ${t}?`],
     ["B", "Hubo un punto de inflexión: cuando aparecieron registros que se podían revisar de forma independiente. A partir de ahí la conversación se volvió más seria."],
     ["A", "¡Vaya! No lo había visto así."]],
    [["A", "¿Y qué es lo que todavía no sabemos?"],
     ["B", "Bastante. Hay preguntas abiertas y sería deshonesto dar respuestas cerradas. Lo que sí podemos hacer es explicar qué hipótesis existen y qué evidencia apoya cada una."],
     ["A", "Me gusta esa honestidad. Muchas veces se presenta la teoría como si fuera un hecho."]],
    [["A", `Si alguien quiere profundizar en ${t}, ¿por dónde empieza?`],
     ["B", "Por fuentes primarias cuando existan, y desconfiando de cualquier relato demasiado perfecto. La curiosidad está bien; la credulidad, no tanto."],
     ["A", "Exacto."]],
  ];
  const closing: [Speaker, string][] = [
    ["A", `Nos quedamos aquí por hoy. ${G}, gracias por acompañarnos.`],
    ["B", "Un placer. Gracias a todos por escuchar."],
  ];
  const targetWords = i.minutes * WORDS_PER_MINUTE;
  const seq: [Speaker, string][] = [...opening];
  let k = 0;
  const words = () => seq.reduce((n, [, s]) => n + s.split(/\s+/).length, 0);
  while (words() < targetWords - 40 && k < 200) { seq.push(...blocks[k % blocks.length].map(([s, x]) => [s, k >= blocks.length ? x.replace(/^/, k % 2 ? "Volviendo a eso: " : "Y otra cosa: ") : x] as [Speaker, string])); k++; if (k >= blocks.length * 2) break; }
  seq.push(...closing);
  return seq.map(([s, x], idx) => ({ id: turnId(idx), speaker: s, text: x, kind: classifyTurn(x, idx, seq.length) }));
}

/** Genera la conversación: LLM (si se inyecta) validado como diálogo coherente; si falla o no hay, plantilla. */
export async function generateConversation(i: GenerateInput, llm?: LlmFn | null): Promise<{ turns: Turn[]; source: "llm" | "plantilla"; note?: string }> {
  if (llm) {
    try {
      const out = await llm(conversationPrompt(i));
      const parsed = parseLabeledScript(out, { A: i.hostName, B: i.guestName });
      if (parsed && coherenceIssues(parsed.turns).length === 0) return { turns: parsed.turns, source: "llm" };
      return { turns: templateConversation(i), source: "plantilla", note: "La respuesta del modelo no era un diálogo coherente; se usó la plantilla." };
    } catch {
      return { turns: templateConversation(i), source: "plantilla", note: "El modelo no respondió; se usó la plantilla (sin costo)." };
    }
  }
  return { turns: templateConversation(i), source: "plantilla" };
}

/** Comprobaciones de coherencia del diálogo: ambos hablan, sin monólogos largos, sin turnos vacíos ni repetidos. */
export function coherenceIssues(turns: Turn[]): string[] {
  const out: string[] = [];
  if (!turns.some((t) => t.speaker === "A") || !turns.some((t) => t.speaker === "B")) out.push("Solo habla un participante.");
  let run = 1;
  for (let i = 1; i < turns.length; i++) { run = turns[i].speaker === turns[i - 1].speaker ? run + 1 : 1; if (run > 3) { out.push(`Monólogo de más de 3 turnos en ${turns[i].id}.`); break; } }
  const seen = new Set<string>();
  for (const t of turns) { if (!t.text.trim()) out.push(`Turno vacío ${t.id}.`); const k = t.text.toLowerCase(); if (seen.has(k)) out.push(`Turno repetido ${t.id}.`); seen.add(k); }
  return out;
}

/** Duración estimada de un turno (s) a ~15 caracteres por segundo, como el resto del podcast. */
export const estimateSeconds = (text: string) => Math.max(1.2, text.length / 15);
