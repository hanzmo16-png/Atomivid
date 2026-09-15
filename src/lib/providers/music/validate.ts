/**
 * Validación ligera de archivos de audio descargados, sin dependencias
 * externas ni `ffmpeg`/`ffprobe` (no están garantizados en el runtime de
 * producción — el worker de GitHub Actions no los trae preinstalados, y
 * Remotion usa su propio binario interno, no el del sistema). Reconoce el
 * formato por sus "magic bytes" y, para WAV, lee sample rate/canales
 * directamente del header (formato simple, sin necesidad de un parser).
 *
 * Limitación conocida y documentada: para MP3/OGG no se extrae duración,
 * canales ni sample rate exactos (requeriría decodificar frames MP3 o
 * añadir una dependencia dedicada) — solo se confirma que el archivo es
 * un MP3/OGG real y no, por ejemplo, una página de error HTML guardada
 * con extensión .mp3 (causa común de fallos silenciosos de descarga).
 */

const MIN_BYTES = 2048;

export type AudioValidationResult =
  | { valid: true; format: "wav" | "mp3" | "ogg"; sampleRate?: number; channels?: number }
  | { valid: false; reason: string };

export function validateAudioBuffer(buffer: Buffer): AudioValidationResult {
  if (buffer.byteLength < MIN_BYTES) {
    return {
      valid: false,
      reason: `archivo demasiado pequeño para ser audio real (${buffer.byteLength} bytes)`,
    };
  }

  if (
    buffer.length >= 44 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  ) {
    const channels = buffer.readUInt16LE(22);
    const sampleRate = buffer.readUInt32LE(24);
    if (channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000) {
      return { valid: false, reason: "header WAV con valores fuera de rango" };
    }
    return { valid: true, format: "wav", sampleRate, channels };
  }

  if (buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "ID3") {
    return { valid: true, format: "mp3" };
  }
  // Frame sync de MPEG: 11 bits en 1 (0xFF seguido de los 3 bits altos en 1).
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return { valid: true, format: "mp3" };
  }
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "OggS") {
    return { valid: true, format: "ogg" };
  }

  return {
    valid: false,
    reason: "no se reconoce como WAV/MP3/OGG (posible descarga corrupta o respuesta de error)",
  };
}
