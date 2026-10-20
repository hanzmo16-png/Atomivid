/**
 * Catálogo OFFLINE de candidatos estilo Pexels (descripción = slug de la página, como en producción).
 * Sintético: ni IDs ni descripciones provienen de una búsqueda real. Sirve para tests y para el
 * ejemplo antes/después del PR; no prueba qué devolvería Pexels hoy.
 */
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";

const c = (sourceId: string, description: string, o: Partial<FootageCandidate> = {}): FootageCandidate => ({
  url: `https://fixture.test/${sourceId}.mp4`, sourceId, mediaType: "video", mimeType: "video/mp4", extension: "mp4",
  width: 1080, height: 1920, durationSeconds: 6, photographer: `author-${sourceId}`, description, ...o,
});

/** Resultados por consulta, en el orden en que «llegarían» del proveedor (el antiguo selector toma el primero). */
export const FIXTURE_RESULTS: Record<string, FootageCandidate[]> = {
  // Escena final del Reel de Hans (transformación + caminar con confianza): el concepto del guion era genérico.
  "new life change": [
    c("px-sad-window", "sad person looking out window rain"),
    c("px-butterfly", "butterfly emerging from cocoon macro"),
  ],
  "new life": [c("px-baby-feet", "close up of baby feet on blanket")],
  "confident professional walking city": [
    c("px-crowd-blur", "blurred crowd crossing street timelapse"),
    c("px-exec-walk", "confident businessperson in suit walking downtown city street"),
    c("px-party", "people dancing at party night"),
  ],
  "business walking": [c("px-office-walk", "business people walking in office corridor")],
  "person walking forward sunrise": [c("px-sunrise-walk", "person walking forward on road at sunrise determined")],
  "self improvement journey": [c("px-books", "stack of books on table")],
  // Escena de disciplina
  "morning routine": [c("px-coffee", "coffee cup on kitchen table morning"), c("px-alarm", "alarm clock ringing bed")],
  "person training workout gym": [c("px-gym", "person training workout in gym lifting weights focused")],
  // Escena de duda
  "uncertain future": [c("px-fog", "foggy road landscape"), c("px-think", "thoughtful person sitting by window at night")],
  "person thinking alone window": [c("px-think-2", "pensive person thinking alone near window")],
  // Escena sin intención clara (control): debe comportarse como antes salvo por palabras del concepto.
  "coffee shop": [c("px-cafe-1", "barista pouring latte art"), c("px-cafe-2", "coffee shop interior with customers")],
};

/** Proveedor offline con contador de llamadas (para comprobar que las búsquedas siguen acotadas). */
export function fixtureFootageProvider(results = FIXTURE_RESULTS): FootageProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fixture-intent",
    calls,
    async fetchFootage() { throw new Error("no usado"); },
    async downloadFootage() { return Buffer.from(""); },
    async searchVideoCandidates(query: string) { calls.push(`video:${query}`); return results[query] ?? []; },
    async searchImageCandidates(query: string) { calls.push(`image:${query}`); return []; },
  };
}

export const SAMPLE_SCENES = [
  { id: "cierre", text: "Hoy empieza tu transformación: camina con confianza hacia la persona que quieres ser.", concepts: ["new life change", "self improvement journey"] },
  { id: "disciplina", text: "La disciplina es entrenar incluso cuando no tienes ganas.", concepts: ["morning routine"] },
  { id: "duda", text: "Todos sentimos miedo y dudas antes de dar el salto.", concepts: ["uncertain future"] },
  { id: "control", text: "Pide tu café y observa a la gente a tu alrededor.", concepts: ["coffee shop"] },
];
