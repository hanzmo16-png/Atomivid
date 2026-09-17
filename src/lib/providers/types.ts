/**
 * Interfaces comunes de proveedor. Cada etapa del pipeline (guion, voz,
 * footage, música) tiene una implementación "real" (llama a la API externa)
 * y una implementación "fixture" (determinística, sin red) que cumple la
 * misma interfaz — así el pipeline completo se puede probar sin claves.
 */

export type SceneEnergy = "low" | "medium" | "high";

export type ScriptScene = {
  text: string;
  /** Concepto visual primario — 2-4 palabras en inglés, editable por el usuario en la revisión del guion. */
  visualQuery: string;
  /**
   * Interpretaciones visuales ALTERNATIVAS de la misma idea (no sinónimos
   * del mismo objeto/escena) — p. ej. para "ahí es donde la mayoría
   * abandona sus sueños": ["exhausted athlete stopping", "person quitting
   * workout", "runner falling behind"], no variaciones de "dreams".
   * Ausente en guiones antiguos o generados por el proveedor fixture — el
   * selector de footage cae a usar solo [visualQuery] cuando falta (ver
   * src/lib/video/footage-select.ts).
   */
  visualConcepts?: string[];
  /** Términos que NO deben aparecer en el material visual de esta escena. */
  excludedTerms?: string[];
  /** Señal de ritmo/energía para el montaje (corte más rápido en escenas "high"). */
  energy?: SceneEnergy;
  /** Palabras de esta escena que deben recibir énfasis visual en los subtítulos (ver caption-emphasis.ts). */
  emphasisWords?: string[];
};

export type GeneratedScript = {
  title: string;
  segments: ScriptScene[];
};

export type ScriptLanguage = "es" | "en";

export interface ScriptProvider {
  readonly name: string;
  generateScript(input: {
    topic: string;
    style: string;
    durationSeconds: number;
    /** Idioma elegido por el usuario en /dashboard/new. Por defecto "es". */
    language?: ScriptLanguage;
  }): Promise<GeneratedScript>;
  /** Reescribe una sola escena (revisión/edición desde la UI). */
  regenerateScene(input: {
    topic: string;
    style: string;
    script: GeneratedScript;
    sceneIndex: number;
  }): Promise<ScriptScene>;
}

export type WordTiming = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type VoiceResult = {
  audioBuffer: Buffer;
  durationSeconds: number;
  words: WordTiming[];
  mimeType: string;
  extension: string;
};

export interface VoiceProvider {
  readonly name: string;
  synthesize(text: string, language?: ScriptLanguage): Promise<VoiceResult>;
}

export type FootageResult = {
  url: string;
  mediaType: "image" | "video";
  photographer?: string;
  mimeType: string;
  extension: string;
};

/**
 * Un resultado candidato (no elegido todavía) — a diferencia de
 * FootageResult, siempre trae un `sourceId` estable para poder
 * deduplicar entre escenas del mismo video, y metadata técnica opcional
 * para puntuar calidad (src/lib/video/footage-score.ts).
 */
export type FootageCandidate = FootageResult & {
  /** Identificador estable del candidato en el proveedor (p. ej. el id numérico de Pexels) — nunca la URL firmada, que puede cambiar. */
  sourceId: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
};

export interface FootageProvider {
  readonly name: string;
  /** Busca preferentemente video vertical; el proveedor puede caer a imagen. */
  fetchFootage(query: string, minimumDurationSeconds?: number): Promise<FootageResult>;
  downloadFootage(url: string): Promise<Buffer>;
  /**
   * Devuelve VARIOS candidatos de video para una consulta (no elige uno
   * solo) — necesario para poder puntuar, diversificar y evitar
   * duplicados entre escenas del mismo video. Opcional: un proveedor que
   * no lo implemente (p. ej. el fixture) hace que el selector caiga a
   * `fetchFootage` como candidato único, sin comparar alternativas.
   */
  searchVideoCandidates?(
    query: string,
    minimumDurationSeconds?: number,
  ): Promise<FootageCandidate[]>;
  /** Igual que `searchVideoCandidates` pero para fotos — último recurso cuando ningún concepto encuentra video. */
  searchImageCandidates?(query: string): Promise<FootageCandidate[]>;
}

/** Categoría de tono musical normalizada — ver src/lib/providers/music/tone.ts. */
export type MusicTone =
  | "motivational"
  | "corporate"
  | "cinematic"
  | "inspirational"
  | "tension"
  | "reflective"
  | "energetic"
  | "minimal"
  | "technology"
  | "luxury";

/** Procedencia verificable de una pista — para poder justificar la licencia. */
export type MusicTrackMetadata = {
  /** Fuente real de la pista (p. ej. "pixabay", "mixkit"), no el mecanismo de selección. */
  provider: string;
  trackId: string;
  title: string;
  author: string;
  sourceUrl: string;
  license: string;
  tones: MusicTone[];
};

export type MusicResult = {
  audioBuffer: Buffer;
  durationSeconds: number;
  mimeType: string;
  extension: string;
  /** Ausente solo en el proveedor fixture o en el modo "lista plana de URLs" sin manifest. */
  track?: MusicTrackMetadata;
};

export type MusicSelectionContext = {
  durationSeconds: number;
  /** Mismo valor que el usuario eligió en /dashboard/new (p. ej. "Motivacional"). */
  style?: string;
  topic?: string;
  /** Texto completo narrado — se escanea por palabras clave para afinar el tono. */
  scriptText?: string;
  language?: ScriptLanguage;
  /**
   * Semilla para que la selección sea determinística y repetible (mismo
   * seed + mismo manifest ⇒ misma pista) — usa el requestId. Sin ella, la
   * elección entre pistas empatadas es aleatoria.
   */
  seed?: string;
};

export interface MusicProvider {
  readonly name: string;
  getTrack(context: MusicSelectionContext): Promise<MusicResult>;
}
