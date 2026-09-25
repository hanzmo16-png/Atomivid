/**
 * Identidad de CONTENIDO de los recursos visuales de un documental (calidad
 * visual M1).
 *
 * Causa raíz confirmada: `dedupKey` era "<beat>:<tipo>:<posición>" —
 * identificaba la RANURA, no el contenido—, y el ejecutor tomaba
 * `candidates[0]` de cada búsqueda sin memoria de lo ya usado. La misma
 * consulta (la misma descripción reciclada) devolvía el mismo clip de
 * Pexels para varias escenas: p. ej. el mismo hombre en una puerta cuatro
 * veces en dos minutos.
 *
 * Un recurso se considera YA USADO en el documental si coincide en
 * cualquiera de estas claves:
 * 1. Identificador estable del proveedor (p. ej. "pexels-video-123") — el
 *    mismo clip en otra resolución/URL.
 * 2. URL canónica (host en minúsculas, sin query ni fragmento: firmas,
 *    tamaños y parámetros de compresión no crean un recurso nuevo).
 * 3. SHA-256 del contenido descargado — el mismo archivo bajo otro id/URL.
 * 4. Hash perceptual (dHash 64 bits, distancia de Hamming ≤ umbral) de la
 *    imagen o de UN fotograma del video — la misma imagen recomprimida o
 *    redimensionada.
 *
 * La identidad es la del RECURSO, no la del tratamiento: la misma imagen
 * con otro zoom/Ken Burns sigue siendo el mismo recurso.
 *
 * Límites (documentados, no ocultos): el dHash es de imagen completa —
 * NO detecta recortes fuertes, espejados ni el mismo sujeto fotografiado
 * desde otro ángulo; en video solo compara un fotograma (≈1 s), así que
 * dos clips distintos de la misma toma larga pueden no coincidir. Al
 * reducir a 9×8 la textura fina desaparece: dos imágenes DISTINTAS pero
 * casi planas (cielo, pared lisa) pueden quedar a distancia ≤ umbral y
 * tratarse como duplicado (falso positivo del lado seguro: se descarta un
 * candidato válido, nunca se repite uno).
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

export type AssetIdentity = {
  provider?: string;
  /** Id estable del proveedor (nunca la URL firmada). */
  sourceId?: string;
  canonicalUrl?: string;
  sha256?: string;
  /** dHash 64 bits en hex (16 caracteres). */
  dhash?: string;
  /** Por qué no hay dHash, si falta (p. ej. "sharp_unavailable"). */
  dhashUnavailable?: string;
};

export const PERCEPTUAL_DUPLICATE_MAX_DISTANCE = 6;

export function canonicalizeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function hammingHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d + Math.abs(a.length - b.length) * 4;
}

/** dHash de una imagen (9×8 en escala de grises, gradiente horizontal). */
export async function dhashImage(buffer: Buffer): Promise<string> {
  const sharp = (await import("sharp")).default;
  const raw = await sharp(buffer).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits += raw[y * 9 + x] > raw[y * 9 + x + 1] ? "1" : "0";
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** Un fotograma PNG del video (≈1 s) vía ffmpeg desde stdin. */
function videoFrame(buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-v", "error", "-ss", "1", "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", reject);
    proc.stdin.on("error", () => {});
    proc.on("close", (code) => (code === 0 && chunks.length > 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg_frame_${code}`))));
    proc.stdin.end(buffer);
  });
}

/** Identidad de contenido de un buffer descargado (el dHash es best-effort y se reporta si falta). */
export async function contentIdentity(buffer: Buffer, mediaType: "image" | "video"): Promise<Pick<AssetIdentity, "sha256" | "dhash" | "dhashUnavailable">> {
  const sha256 = sha256Hex(buffer);
  try {
    const frame = mediaType === "video" ? await videoFrame(buffer) : buffer;
    return { sha256, dhash: await dhashImage(frame) };
  } catch (err) {
    return { sha256, dhashUnavailable: err instanceof Error ? err.message.slice(0, 80) : "unknown" };
  }
}

export type DuplicateMatch = { key: "sourceId" | "canonicalUrl" | "sha256" | "dhash"; shotId: string; distance?: number };

/**
 * Registro de todo el documental: qué recurso usa cada escena. Se siembra
 * con los registros durables YA completados (reintentos: la continuidad no
 * depende del orden de ejecución) antes de elegir ningún candidato nuevo.
 */
export class DocumentAssetRegistry {
  private readonly bySourceId = new Map<string, string>();
  private readonly byUrl = new Map<string, string>();
  private readonly bySha = new Map<string, string>();
  private readonly hashes: { dhash: string; shotId: string }[] = [];
  private readonly byShot = new Map<string, AssetIdentity>();

  register(shotId: string, identity: AssetIdentity): void {
    this.byShot.set(shotId, identity);
    if (identity.sourceId) this.bySourceId.set(`${identity.provider ?? ""}:${identity.sourceId}`, shotId);
    if (identity.canonicalUrl) this.byUrl.set(identity.canonicalUrl, shotId);
    if (identity.sha256) this.bySha.set(identity.sha256, shotId);
    if (identity.dhash) this.hashes.push({ dhash: identity.dhash, shotId });
  }

  /** Antes de descargar: id del proveedor o URL canónica ya usados por OTRA escena. */
  findByReference(identity: Pick<AssetIdentity, "provider" | "sourceId" | "canonicalUrl">, exceptShotId?: string): DuplicateMatch | null {
    const bySource = identity.sourceId ? this.bySourceId.get(`${identity.provider ?? ""}:${identity.sourceId}`) : undefined;
    if (bySource && bySource !== exceptShotId) return { key: "sourceId", shotId: bySource };
    const byUrl = identity.canonicalUrl ? this.byUrl.get(identity.canonicalUrl) : undefined;
    if (byUrl && byUrl !== exceptShotId) return { key: "canonicalUrl", shotId: byUrl };
    return null;
  }

  /** Después de descargar: mismo contenido exacto o perceptualmente casi idéntico. */
  findByContent(identity: Pick<AssetIdentity, "sha256" | "dhash">, exceptShotId?: string): DuplicateMatch | null {
    const bySha = identity.sha256 ? this.bySha.get(identity.sha256) : undefined;
    if (bySha && bySha !== exceptShotId) return { key: "sha256", shotId: bySha };
    if (identity.dhash) {
      for (const h of this.hashes) {
        if (h.shotId === exceptShotId) continue;
        const distance = hammingHex(identity.dhash, h.dhash);
        if (distance <= PERCEPTUAL_DUPLICATE_MAX_DISTANCE) return { key: "dhash", shotId: h.shotId, distance };
      }
    }
    return null;
  }

  identityOf(shotId: string): AssetIdentity | undefined {
    return this.byShot.get(shotId);
  }

  get size(): number {
    return this.byShot.size;
  }
}
