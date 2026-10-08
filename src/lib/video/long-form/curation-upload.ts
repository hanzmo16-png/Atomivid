/**
 * Curator file upload (images only). The browser uploads straight to the private "videos" bucket with a
 * one-time signed upload URL (no serverless body limit); the server then re-reads the stored bytes and is
 * the only judge: real type from magic bytes (the declared MIME is ignored), pixel size from the file
 * header, ≥ 1280 px long side, size cap, SHA-256 of the exact content. A valid upload only becomes a
 * PROPOSAL for one contract; approval stays a separate, explicit decision of an authorized curator.
 */
import { createHash, randomUUID } from "node:crypto";
import { HERO_MIN_LONG_SIDE_PX } from "./verified-assets";

export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type UploadMime = (typeof UPLOAD_MIME)[number];
const EXT: Record<UploadMime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
/** Signed media URL lifetime stored in the proposal (the renderer downloads it; SHA-256 is re-checked). */
export const UPLOAD_MEDIA_URL_TTL_SECONDS = 365 * 24 * 3600;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const uploadPrefix = (requestId: string) => `${requestId}/curation/uploads/`;
export function newUploadPath(requestId: string, mime: UploadMime): string {
  return `${uploadPrefix(requestId)}${randomUUID()}.${EXT[mime]}`;
}
/** Only paths this feature minted for THIS request are accepted back (no traversal, no other objects). */
export function isUploadPathFor(requestId: string, path: string): boolean {
  return new RegExp(`^${requestId.replace(/[^0-9a-f-]/gi, "")}/curation/uploads/${UUID}\\.(jpg|png|webp)$`).test(path);
}

export type SniffedImage = { mime: UploadMime; width: number; height: number };

/** Type and pixel size from the bytes themselves. */
export function sniffImage(buf: Buffer): SniffedImage | { error: string } {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString("ascii", 12, 16) === "IHDR")
    return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { mime: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      if (len < 2) break;
      i += 2 + len;
    }
    return { error: "JPEG sin cabecera de dimensiones legible" };
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { mime: "image/webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8 " && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a)
      return { mime: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && buf[20] === 0x2f) {
      const b = buf.readUInt32LE(21);
      return { mime: "image/webp", width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    return { error: "WebP con formato no reconocido" };
  }
  return { error: "el archivo no es una imagen JPEG, PNG o WebP" };
}

export type ValidatedUpload = SniffedImage & { sha256: string; bytes: number };

export function validateUpload(buf: Buffer): ValidatedUpload | { error: string } {
  if (buf.length === 0) return { error: "archivo vacío" };
  if (buf.length > UPLOAD_MAX_BYTES) return { error: `el archivo supera ${UPLOAD_MAX_BYTES / 1024 / 1024} MB` };
  const img = sniffImage(buf);
  if ("error" in img) return img;
  if (!(img.width > 0 && img.height > 0)) return { error: "dimensiones inválidas" };
  const longSide = Math.max(img.width, img.height);
  if (longSide < HERO_MIN_LONG_SIDE_PX) return { error: `lado largo ${longSide} px < ${HERO_MIN_LONG_SIDE_PX} px (no se reescala)` };
  return { ...img, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}
