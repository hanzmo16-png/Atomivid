/**
 * Interfaces comunes de proveedor. Cada etapa del pipeline (guion, voz,
 * footage, música) tiene una implementación "real" (llama a la API externa)
 * y una implementación "fixture" (determinística, sin red) que cumple la
 * misma interfaz — así el pipeline completo se puede probar sin claves.
 */

export type ScriptScene = {
  text: string;
  visualQuery: string;
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

export interface FootageProvider {
  readonly name: string;
  /** Busca preferentemente video vertical; el proveedor puede caer a imagen. */
  fetchFootage(query: string, minimumDurationSeconds?: number): Promise<FootageResult>;
  downloadFootage(url: string): Promise<Buffer>;
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
