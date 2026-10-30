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

/**
 * Ritmo REAL de las voces del estudio: 13,5 caracteres por segundo (episodio b9c6784d, 2026-10-28: 5.044 caracteres en
 * 373 s de voz, Callie + voz clonada). Con los 15 car./s y 150 palabras/min anteriores, un episodio pedido de 5 min salió
 * de 6:19. La duración se cumple ajustando la LONGITUD del guion, nunca la velocidad de la voz.
 */
export const SPOKEN_CHARS_PER_SECOND = 13.5;
/** Pausa media entre turnos y cortinas de entrada/salida (las mismas que suma el estudio al montar la voz). */
export const TURN_GAP_SECONDS = 0.4, OPEN_CLOSE_SECONDS = 5.5;
/** Caracteres medios por palabra hablada en español (incluido el espacio). */
export const CHARS_PER_WORD = 6;
/** Tolerancia de la duración frente al objetivo (la misma que Long Form). */
export const DURATION_TOLERANCE = 0.15;
const AVG_TURN_CHARS = 190;

/** Caracteres de guion que caben en `minutes` (descontando cortinas y pausas entre turnos). */
export function targetChars(minutes: number): number {
  return Math.max(200, Math.round((minutes * 60 - OPEN_CLOSE_SECONDS) * SPOKEN_CHARS_PER_SECOND / (1 + TURN_GAP_SECONDS * SPOKEN_CHARS_PER_SECOND / AVG_TURN_CHARS)));
}
export const targetWords = (minutes: number) => Math.round(targetChars(minutes) / CHARS_PER_WORD);

/** Duración estimada de un episodio con estos turnos (voz + pausas + cortinas), en segundos. */
export function episodeSeconds(turns: Pick<Turn, "text">[]): number {
  return OPEN_CLOSE_SECONDS + turns.reduce((n, t) => n + estimateSeconds(t.text) + TURN_GAP_SECONDS, 0);
}

export function conversationPrompt(i: GenerateInput): string {
  return [
    `Escribe un guion de podcast en español latinoamericano sobre: «${i.topic}».`,
    `Participantes: ${i.hostName} (anfitrión) y ${i.guestName}${i.guestRole ? ` (${i.guestRole})` : ""}.`,
    `Duración: ${i.minutes} minutos. Extensión total: entre ${Math.round(targetWords(i.minutes) * 0.9)} y ${targetWords(i.minutes)} palabras (cuéntalas: un guion más largo dura más de lo pedido y la voz no se acelera).`,
    ...(i.hostPersonality || i.guestPersonality ? [`Personalidades: ${i.hostName}: ${i.hostPersonality || "neutral"}; ${i.guestName}: ${i.guestPersonality || "neutral"}.`] : []),
    "Formato estricto: una línea por turno, «Nombre: texto». Alterna preguntas, respuestas, comentarios, reacciones breves, al menos un desacuerdo razonado y transiciones entre bloques.",
    "Coherencia: cada turno responde al anterior. No inventes citas ni datos verificables; si algo es especulación, dilo.",
    "Abre con una presentación y cierra con una despedida.",
  ].join("\n");
}

/** Respaldo determinista (sin red, sin costo): estructura de entrevista coherente con el tema. */
/**
 * Tema tal como lo escribió el usuario, limpio para decirlo en voz alta: sin signos de pregunta sueltos, espacios ni
 * punto final. La plantilla no corrige ortografía (eso lo hace el guion con IA); por eso solo lo nombra en la apertura
 * (auditoría 2026-10-30, episodio 51883d1c: «despurs de la muerte» se leyó literalmente cinco veces).
 */
export function cleanTopic(topic: string): string {
  const t = topic.replace(/\s+/g, " ").replace(/^[¿¡"«\s]+|[?!.。"»\s]+$/g, "").trim();
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : "";
}

export function templateConversation(i: GenerateInput): Turn[] {
  const named = cleanTopic(i.topic) || "nuestro tema";
  const t = "este tema";
  const H = i.hostName, G = i.guestName;
  const opening: [Speaker, string][] = [
    ["A", `Bienvenidos a un nuevo episodio. Hoy hablamos de ${named}, y me acompaña ${G}${i.guestRole ? `, ${i.guestRole}` : ""}. ¡Gracias por venir!`],
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
    [["A", `¿Cuál es el malentendido más común sobre ${t}?`],
     ["B", "Pensar que todo lo que se cuenta tiene el mismo peso. Una inscripción, una traducción y una interpretación moderna no son lo mismo, y muchas veces se mezclan como si lo fueran."],
     ["A", "O sea, que el problema no es solo qué se dice, sino de dónde viene."],
     ["B", "Exacto. Antes de opinar conviene preguntar quién lo dijo, cuándo y con qué evidencia."]],
    [["A", "Hablemos ahora de las interpretaciones. ¿Por qué hay versiones tan distintas de lo mismo?"],
     ["B", "Porque cada época lee el pasado con sus propias preguntas. Lo que para unos es un mito con sentido simbólico, para otros es un relato literal, y para otros un misterio sin resolver."],
     ["A", "No estoy de acuerdo del todo: algunas versiones simplemente están mejor sustentadas que otras."],
     ["B", "Tienes razón en eso. No todas valen lo mismo; las que se apoyan en fuentes verificables y en el trabajo de especialistas pesan más que las ocurrencias."]],
    [["A", `¿Qué dicen hoy los especialistas sobre ${t}?`],
     ["B", "Que hay mucho que aprender todavía. Se siguen revisando traducciones, se comparan fragmentos y se discuten dataciones; es un campo vivo, no un expediente cerrado."],
     ["A", "Eso me gusta: la ciencia como una conversación que continúa."],
     ["B", "Justamente. Y cuando aparece un dato nuevo, lo honesto es estar dispuesto a cambiar de opinión."]],
    [["A", "¿Por qué crees que este tema atrae a tanta gente?"],
     ["B", "Porque toca preguntas muy humanas: de dónde venimos, quién estuvo antes que nosotros y qué tanto sabemos de verdad. Eso despierta curiosidad, y también imaginación."],
     ["A", "¡Claro! Y la imaginación vende más que los matices."],
     ["B", "A veces sí. Por eso vale la pena contar las dos cosas: lo fascinante y lo que efectivamente está documentado."]],
    [["A", "Cambiando de tema: ¿cómo se distingue una buena fuente de una mala?"],
     ["B", "Mirando si se puede comprobar. Una buena fuente dice de dónde saca lo que afirma, distingue entre dato e interpretación y no esconde lo que no sabe."],
     ["A", "¿Y las que prometen revelar el secreto definitivo?"],
     ["B", "Esas, con mucha cautela. Cuando algo suena demasiado perfecto, normalmente es porque le faltan las partes incómodas."],
     ["A", "Muy buen criterio, y sirve para cualquier tema."]],
    [["A", `Si tuvieras que resumir ${t} en una sola idea, ¿cuál sería?`],
     ["B", "Que la historia real ya es extraordinaria. No hace falta exagerarla para que nos sorprenda; basta con contarla bien y con respeto por la evidencia."],
     ["A", "Me quedo con eso. Lo extraordinario no necesita adornos."],
     ["B", "Y lo que no sabemos tampoco es un fracaso: es la parte que todavía nos queda por descubrir."]],
    [["A", `Si alguien quiere profundizar en ${t}, ¿por dónde empieza?`],
     ["B", "Por fuentes primarias cuando existan, y desconfiando de cualquier relato demasiado perfecto. La curiosidad está bien; la credulidad, no tanto."],
     ["A", "Exacto."]],
  ];
  const closing: [Speaker, string][] = [
    ["A", `Nos quedamos aquí por hoy. ${G}, gracias por acompañarnos.`],
    ["B", "Un placer. Gracias a todos por escuchar."],
  ];
  // Bloques enteros mientras quepan en la duración; nunca se repite un bloque (antes se repetían con «Y otra cosa:» y
  // «Volviendo a eso:», y un episodio de 5 min salió de 6:19 con preguntas dichas dos veces).
  const budget = targetChars(i.minutes) * (1 + DURATION_TOLERANCE / 3);
  const chars = (xs: [Speaker, string][]) => xs.reduce((n, [, s]) => n + s.length, 0);
  const seq: [Speaker, string][] = [...opening];
  for (const block of blocks) { if (chars(seq) + chars(block) + chars(closing) > budget && seq.length > opening.length) break; seq.push(...block); }
  seq.push(...closing);
  return seq.map(([s, x], idx) => ({ id: turnId(idx), speaker: s, text: x, kind: classifyTurn(x, idx, seq.length) }));
}

/** Genera la conversación: LLM (si se inyecta) validado como diálogo coherente; si falla o no hay, plantilla. */
export async function generateConversation(i: GenerateInput, llm?: LlmFn | null): Promise<{ turns: Turn[]; source: "llm" | "plantilla"; note?: string }> {
  if (llm) {
    try {
      const out = await llm(conversationPrompt(i));
      const parsed = parseLabeledScript(out, { A: i.hostName, B: i.guestName });
      if (parsed && coherenceIssues(parsed.turns).length === 0) {
        const fitted = fitToDuration(parsed.turns, i.minutes);
        return { turns: fitted.turns, source: "llm", ...(fitted.trimmed ? { note: `El modelo escribió de más: se quitaron ${fitted.trimmed} turnos del final del desarrollo para respetar ${i.minutes} min (la voz no se acelera).` } : {}) };
      }
      return { turns: templateConversation(i), source: "plantilla", note: "La respuesta del modelo no era un diálogo coherente; se usó la plantilla." };
    } catch {
      return { turns: templateConversation(i), source: "plantilla", note: "El modelo no respondió; se usó la plantilla (sin costo)." };
    }
  }
  return { turns: templateConversation(i), source: "plantilla" };
}

/**
 * Recorta un guion demasiado largo para la duración pedida: quita turnos completos del FINAL del desarrollo (conserva la
 * apertura y los dos turnos de cierre) hasta quedar dentro de la tolerancia. Nunca toca la velocidad de la voz.
 */
export function fitToDuration(turns: Turn[], minutes: number): { turns: Turn[]; trimmed: number } {
  const limit = minutes * 60 * (1 + DURATION_TOLERANCE / 3);
  const body = [...turns];
  const closing = body.length > 4 ? body.splice(body.length - 2, 2) : [];
  let trimmed = 0;
  while (body.length > 3 && episodeSeconds([...body, ...closing]) > limit) { body.pop(); trimmed++; }
  const out = [...body, ...closing];
  return { turns: trimmed ? out.map((t, idx) => ({ ...t, id: turnId(idx), kind: classifyTurn(t.text, idx, out.length) })) : turns, trimmed };
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

/** Duración estimada de un turno (s) al ritmo real de las voces del estudio. */
export const estimateSeconds = (text: string) => Math.max(1.2, text.length / SPOKEN_CHARS_PER_SECOND);
