/**
 * App side of the external podcast editor exchange (bucket "podcast-editor", migration 20261009185427).
 *
 * Paths mirror the approved Storage policies exactly: episodios/<episode_id>/v<version>/{entrada,salida,estado}/…
 * with the same episode/version patterns as podcast_editor.permiso_objeto(). Anything else is rejected here
 * before it reaches Storage.
 *
 * COMPLETO.json — ASSUMED SHAPE, PENDING CONFIRMATION WITH THE EDITOR (Grok). The editor's own schema was not
 * available in the repository or PR #85; the field names below are this app's proposal and live only in this
 * module. Parsing fails closed: an unrecognised COMPLETO.json never makes an episode "terminado".
 *
 *   {
 *     "episode_id": "<same as path>",
 *     "version": <same as path>,
 *     "salidas": [ { "archivo": "<file name inside salida/>", "bytes": <int>, "sha256": "<64 hex>" } ]
 *   }
 */
export const EDITOR_BUCKET = "podcast-editor";
export const COMPLETE_MARKER = "COMPLETO.json";

const EPISODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const VERSION_SEGMENT = /^v[1-9][0-9]{0,8}$/;
// One plain file name inside salida/: no separators, no dot segments, no control characters.
const OUTPUT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function validEpisodeId(id: unknown): id is string {
  return typeof id === "string" && EPISODE_ID.test(id);
}

/** "v3" → 3; anything not matching the policy's version pattern → null. */
export function parseVersionSegment(segment: unknown): number | null {
  if (typeof segment !== "string" || !VERSION_SEGMENT.test(segment)) return null;
  return Number(segment.slice(1));
}

export function validVersion(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 999_999_999;
}

export function versionFolder(episodeId: string, version: number): string {
  if (!validEpisodeId(episodeId) || !validVersion(version)) throw new Error("episodio/versión inválidos");
  return `episodios/${episodeId}/v${version}`;
}

export const outputFolder = (episodeId: string, version: number) => `${versionFolder(episodeId, version)}/salida`;

export type DeclaredOutput = { archivo: string; bytes: number; sha256: string };
export type CompleteManifest = { episodeId: string; version: number; salidas: DeclaredOutput[] };

export type ManifestResult = { ok: true; manifest: CompleteManifest } | { ok: false; reason: string };

/** Strict parse of COMPLETO.json for the expected episode/version (see the assumed shape above). */
export function parseCompleteManifest(raw: string, expected: { episodeId: string; version: number }): ManifestResult {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { ok: false, reason: "COMPLETO.json no es JSON válido" }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "COMPLETO.json no es un objeto" };
  const d = data as Record<string, unknown>;
  if (d.episode_id !== expected.episodeId) return { ok: false, reason: "COMPLETO.json declara otro episodio" };
  if (d.version !== expected.version) return { ok: false, reason: "COMPLETO.json declara otra versión" };
  if (!Array.isArray(d.salidas) || d.salidas.length === 0) return { ok: false, reason: "COMPLETO.json no declara salidas" };
  if (d.salidas.length > 50) return { ok: false, reason: "COMPLETO.json declara demasiadas salidas" };
  const seen = new Set<string>();
  const salidas: DeclaredOutput[] = [];
  for (const item of d.salidas) {
    if (!item || typeof item !== "object") return { ok: false, reason: "salida mal formada" };
    const { archivo, bytes, sha256 } = item as Record<string, unknown>;
    if (typeof archivo !== "string" || !OUTPUT_FILE.test(archivo) || archivo === COMPLETE_MARKER || /\.\./.test(archivo)) {
      return { ok: false, reason: "nombre de salida no permitido" };
    }
    if (seen.has(archivo)) return { ok: false, reason: "salida repetida" };
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) return { ok: false, reason: `tamaño inválido en ${archivo}` };
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) return { ok: false, reason: `sha256 inválido en ${archivo}` };
    seen.add(archivo);
    salidas.push({ archivo, bytes, sha256 });
  }
  return { ok: true, manifest: { episodeId: expected.episodeId, version: expected.version, salidas } };
}

/** The file the owner plays first: the first declared MP4/M4A/MP3/WAV/WebM output. */
export function primaryMedia(salidas: DeclaredOutput[]): DeclaredOutput | null {
  return salidas.find((s) => /\.(mp4|m4a|mp3|wav|webm)$/i.test(s.archivo)) ?? null;
}
