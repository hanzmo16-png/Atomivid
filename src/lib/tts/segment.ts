/**
 * «Texto a voz» — lógica pura (sin I/O, apta para el navegador): normalizar
 * el guion, dividirlo en fragmentos con pausas naturales, estimar duración
 * y consumo, y validar la solicitud.
 *
 * Fragmentos: se corta por párrafos y, dentro de un párrafo largo, entre
 * oraciones; una oración más larga que el máximo se corta en una pausa
 * (, ; :) y, en último caso, entre palabras. Nunca se corta una palabra.
 * Cada fragmento sabe qué pausa va después (más larga al cerrar un
 * párrafo) y qué texto lo rodea, para que ElevenLabs mantenga la entonación
 * (previous_text / next_text; ese contexto no se narra).
 */

export type TtsLanguage = "es" | "en";

export type TtsSegment = {
  index: number;
  text: string;
  /** Silencio a insertar después de este fragmento (0 en el último). */
  pauseAfterMs: number;
  previousText?: string;
  nextText?: string;
};

/** Máximo de caracteres por llamada a ElevenLabs: bien por debajo del límite del modelo y con fragmentos que se reintentan baratos. */
export const TTS_SEGMENT_MAX_CHARS = 900;
export const PARAGRAPH_PAUSE_MS = 650;
export const SENTENCE_PAUSE_MS = 180;
/** Contexto vecino que se envía (caracteres). */
export const CONTEXT_CHARS = 280;
/** Ritmo de lectura medio con eleven_multilingual_v2 a velocidad 1.0 (estimación; la duración real se mide al terminar). */
export const TTS_CHARS_PER_SECOND = 15;

export const TTS_TITLE_MAX = 120;
/** Límite técnico de la tabla (tts_jobs.script); el límite de producto es ttsMaxCharsPerPiece. */
export const TTS_SCRIPT_HARD_MAX = 20000;

/** Miles con punto, igual en servidor y navegador (toLocaleString("es") no agrupa números de 4 cifras). */
export function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function normalizeScript(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Oraciones de un párrafo (conserva la puntuación final y las comillas/cierres pegados). */
function sentences(paragraph: string): string[] {
  const text = paragraph.replace(/\n/g, " ");
  const parts = text.split(/(?<=[.!?…]["'»”)\]]*)\s+/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Corta un texto más largo que `max` en una pausa y, si no hay, entre palabras. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "), window.lastIndexOf(" — "));
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max; // una «palabra» de más de `max` caracteres: no hay otra opción
    else cut += 1; // incluye la coma/espacio en el trozo izquierdo
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function segmentScript(raw: string, maxChars = TTS_SEGMENT_MAX_CHARS): TtsSegment[] {
  const script = normalizeScript(raw);
  if (!script) return [];
  const paragraphs = script.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const pieces: { text: string; endsParagraph: boolean }[] = [];
  for (const paragraph of paragraphs) {
    const units = sentences(paragraph).flatMap((s) => splitLong(s, maxChars));
    let current = "";
    for (const unit of units) {
      if (current && current.length + 1 + unit.length > maxChars) {
        pieces.push({ text: current, endsParagraph: false });
        current = unit;
      } else {
        current = current ? `${current} ${unit}` : unit;
      }
    }
    if (current) pieces.push({ text: current, endsParagraph: true });
  }
  return pieces.map((piece, index) => {
    const last = index === pieces.length - 1;
    const prev = pieces[index - 1]?.text;
    const next = pieces[index + 1]?.text;
    return {
      index,
      text: piece.text,
      pauseAfterMs: last ? 0 : piece.endsParagraph ? PARAGRAPH_PAUSE_MS : SENTENCE_PAUSE_MS,
      ...(prev ? { previousText: prev.slice(-CONTEXT_CHARS) } : {}),
      ...(next ? { nextText: next.slice(0, CONTEXT_CHARS) } : {}),
    };
  });
}

/** Caracteres que cobra el proveedor: los del texto narrado (el contexto vecino no se cobra como narración). */
export function billableCharacters(segments: TtsSegment[]): number {
  return segments.reduce((sum, s) => sum + s.text.length, 0);
}

export function estimateSeconds(segments: TtsSegment[]): number {
  const speech = billableCharacters(segments) / TTS_CHARS_PER_SECOND;
  const pauses = segments.reduce((sum, s) => sum + s.pauseAfterMs, 0) / 1000;
  return Math.round((speech + pauses) * 10) / 10;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m} min ${String(s).padStart(2, "0")} s` : `${s} s`;
}

export type TtsLimits = { maxCharsPerPiece: number; maxCharsPerUserMonth: number; usedThisMonth: number };

export type TtsInput = { title: string; script: string; language: TtsLanguage };

/** Valida título, guion, idioma y límites. Devuelve el guion normalizado y sus fragmentos. */
export function validateTtsInput(
  raw: { title: unknown; script: unknown; language: unknown },
  limits: TtsLimits,
): { ok: true; input: TtsInput; segments: TtsSegment[]; characters: number } | { ok: false; error: string } {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return { ok: false, error: "Escribe un título." };
  if (title.length > TTS_TITLE_MAX) return { ok: false, error: `El título admite hasta ${TTS_TITLE_MAX} caracteres.` };
  if (raw.language !== "es" && raw.language !== "en") return { ok: false, error: "Elige español o inglés." };
  const script = typeof raw.script === "string" ? normalizeScript(raw.script) : "";
  if (!script) return { ok: false, error: "Escribe el texto que quieres narrar." };
  const segments = segmentScript(script);
  const characters = billableCharacters(segments);
  const max = Math.min(limits.maxCharsPerPiece, TTS_SCRIPT_HARD_MAX);
  if (characters > max) return { ok: false, error: `El texto tiene ${formatCount(characters)} caracteres; el máximo por pieza es ${formatCount(max)}.` };
  const remaining = Math.max(0, limits.maxCharsPerUserMonth - limits.usedThisMonth);
  if (characters > remaining) {
    return { ok: false, error: `Este mes te quedan ${formatCount(remaining)} caracteres de Texto a voz y el texto tiene ${formatCount(characters)}.` };
  }
  return { ok: true, input: { title, script, language: raw.language }, segments, characters };
}

/** Primer día del mes en curso (UTC), para contar el consumo mensual. */
export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Consumo del mes: piezas en curso o completadas, y las fallidas que llegaron a generar algún fragmento (pudieron cobrarse). */
export function monthlyCharactersUsed(rows: { characters: number; status: string; segments_done: number | null }[]): number {
  return rows.reduce((sum, r) => (r.status === "failed" && !r.segments_done ? sum : sum + r.characters), 0);
}

/** Nombre de archivo seguro para la descarga del MP3. */
export function downloadFileName(title: string): string {
  const base = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return `${base || "texto-a-voz"}.mp3`;
}
