/**
 * Errores tipados del proveedor de música, para que el pipeline (ver
 * generate.ts) pueda distinguir por qué falló y decidir el fallback
 * correcto sin adivinar a partir del mensaje de texto.
 */

/** No hay ninguna pista disponible (manifest vacío o sin coincidencia posible). */
export class MusicNoMatchError extends Error {
  constructor(message = "No hay pistas de música disponibles.") {
    super(message);
    this.name = "MusicNoMatchError";
  }
}

/** El proveedor en sí falló antes de intentar descargar nada (config inválida, etc.). */
export class MusicProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicProviderError";
  }
}

/** El objeto no existe en el bucket privado de la biblioteca de música (ruta mal escrita, archivo borrado/nunca subido). */
export class MusicObjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicObjectNotFoundError";
  }
}

/** El objeto existe pero Supabase no pudo firmar una URL de lectura temporal para él. */
export class MusicSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicSigningError";
  }
}

/** La pista se identificó pero no se pudo descargar (red, 404, timeout). */
export class MusicDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicDownloadError";
  }
}

/** Se descargó algo, pero no es un archivo de audio válido (ver validate.ts). */
export class MusicInvalidFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicInvalidFileError";
  }
}

/**
 * Modo dirigido (dirección audiovisual): ninguna pista COMPATIBLE con la
 * dirección musical aprobada está disponible. Nunca se sustituye por otra
 * pista cualquiera ni por música generada de pago — el llamador detiene la
 * producción con una ruta de recuperación visible.
 */
export class MusicNoCompatibleTrackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicNoCompatibleTrackError";
  }
}
