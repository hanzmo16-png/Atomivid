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

export interface ScriptProvider {
  readonly name: string;
  generateScript(input: {
    topic: string;
    style: string;
    durationSeconds: number;
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
  synthesize(text: string): Promise<VoiceResult>;
}

export type FootageResult = {
  url: string;
  photographer?: string;
  mimeType: string;
  extension: string;
};

export interface FootageProvider {
  readonly name: string;
  fetchImage(query: string): Promise<FootageResult>;
  downloadImage(url: string): Promise<Buffer>;
}

export type MusicResult = {
  audioBuffer: Buffer;
  durationSeconds: number;
  mimeType: string;
  extension: string;
};

export interface MusicProvider {
  readonly name: string;
  /**
   * `style` es el mismo valor que el usuario eligió en /dashboard/new
   * (p. ej. "Motivacional", "Humor") — opcional porque no todos los
   * proveedores lo usan (el fixture lo ignora), pero permite elegir una
   * pista acorde en vez de puramente al azar.
   */
  getTrack(durationSeconds: number, style?: string): Promise<MusicResult>;
}
