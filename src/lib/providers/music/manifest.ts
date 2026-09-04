/**
 * Banco de música de fondo con procedencia verificable. Cada entrada debe
 * tener una licencia confirmada para uso comercial ANTES de agregarse
 * aquí — nunca una pista de licencia ambigua o dudosa (ver README, sección
 * "Música de fondo: banco inicial", para los criterios exactos y el paso a
 * paso para llenarlo).
 *
 * Este archivo solo referencia metadata (para poder demostrar de dónde
 * salió cada pista si algún día hay que justificarlo) — el audio en sí
 * vive donde `storageUrl` apunte (p. ej. el bucket de Supabase Storage del
 * proyecto), nunca en este repositorio.
 */
export type MusicTrackEntry = {
  /** Identificador corto y estable, usado solo en logs/debug. */
  id: string;
  title: string;
  author: string;
  /** Página del banco de origen donde se puede verificar la licencia. */
  sourceUrl: string;
  /** Nombre de la licencia bajo la que se descargó (no un link genérico). */
  license: string;
  /**
   * Con qué estilos de video (los mismos valores del selector en
   * /dashboard/new) combina esta pista. Una pista puede tener varios tags;
   * `getTrack` intenta un tag que coincida con el estilo del video antes
   * de elegir al azar de todo el banco.
   */
  styleTags: string[];
  /** URL pública (o firmada) desde donde el pipeline puede descargarla. */
  storageUrl: string;
};

// Banco inicial: vacío a propósito. Este entorno de desarrollo no tiene
// salida de red hacia bancos de música (Pixabay/Mixkit/etc.), así que no
// se pudo descargar ni verificar ninguna pista real desde aquí — hacerlo
// requiere que el usuario la seleccione y confirme la licencia. Mientras
// esté vacío, el proveedor de música cae a MUSIC_TRACK_URLS (una lista
// plana, sin estilos) y, si tampoco hay nada configurado, al fixture.
export const MUSIC_MANIFEST: MusicTrackEntry[] = [];
