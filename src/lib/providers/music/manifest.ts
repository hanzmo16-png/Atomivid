import type { MusicTone } from "../types";

/**
 * Banco de música de fondo con procedencia verificable. Cada entrada debe
 * tener una licencia confirmada para uso comercial ANTES de agregarse
 * aquí — nunca una pista de licencia ambigua o dudosa (ver README, sección
 * "Música de fondo: banco inicial", para los criterios exactos y el paso a
 * paso para llenarlo).
 *
 * Este archivo solo referencia metadata (para poder demostrar de dónde
 * salió cada pista si algún día hay que justificarlo) — el audio en sí
 * vive en el bucket privado `music-library` de Supabase Storage (nunca en
 * este repositorio), referenciado por `storagePath`. El pipeline firma una
 * URL de lectura temporal bajo demanda para descargarlo — ver
 * src/lib/providers/music/storage.ts.
 */
export type MusicTrackEntry = {
  /** Identificador corto y estable, usado en logs/debug y como trackId en generation_costs (futuro). */
  id: string;
  title: string;
  author: string;
  /** Página del banco de origen donde se puede verificar la licencia. */
  sourceUrl: string;
  /** Nombre de la licencia bajo la que se descargó (no un link genérico). */
  license: string;
  /**
   * Fuente real de la pista (p. ej. "pixabay", "mixkit") — distinto del
   * nombre del MusicProvider ("curated-library"), que es el mecanismo de
   * selección, no la procedencia de cada pista individual.
   */
  provider: string;
  /** Fecha (ISO 8601, solo fecha) en que se descargó/verificó la licencia. */
  dateObtainedISO: string;
  /** Debe ser instrumental (sin voz) — condición obligatoria, ver README. */
  instrumental: true;
  /**
   * Tonos normalizados con los que combina esta pista (ver tone.ts) — el
   * algoritmo de selección puntúa por coincidencia con los tonos
   * inferidos del video. Una pista puede tener varios.
   */
  tones: MusicTone[];
  /**
   * Compatibilidad con el selector de estilo de /dashboard/new (valores
   * tal como aparecen ahí, p. ej. "Motivacional") — usado solo como señal
   * adicional si se quiere filtrar/depurar por estilo literal; la
   * selección real usa `tones`.
   */
  styleTags: string[];
  /**
   * Ruta del objeto dentro del bucket privado `music-library` (ver
   * src/lib/providers/music/storage.ts) — NO una URL pública ni una URL
   * firmada. El pipeline firma una URL de lectura de máximo 1 hora bajo
   * demanda, solo en el servidor, en el momento de renderizar — nunca se
   * guarda ni se envía una URL descargable permanente. Ejemplo:
   * "pixabay-335162-upbeat-corporate-inspiring.mp3".
   */
  storagePath: string;
};

// Banco inicial: vacío a propósito. Este entorno de desarrollo no tiene
// salida de red hacia bancos de música (Pixabay Music/Mixkit/etc.), así
// que no se pudo descargar ni verificar ninguna pista real desde aquí —
// hacerlo requiere que el usuario la seleccione y confirme la licencia
// (ver README, "Música de fondo: banco inicial", para el paso a paso
// exacto con el esquema de arriba). Mientras esté vacío, el proveedor cae
// a MUSIC_TRACK_URLS (lista plana, sin tonos/metadata) y, si tampoco hay
// nada configurado, al fixture.
export const MUSIC_MANIFEST: MusicTrackEntry[] = [];
