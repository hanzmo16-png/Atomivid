/**
 * App side of the external podcast editor exchange (bucket "podcast-editor", migration 20261009185427).
 *
 * Paths mirror the approved Storage policies exactly: episodios/<episode_id>/v<version>/{entrada,salida,estado}/…
 * with the same episode/version patterns as podcast_editor.permiso_objeto(). Anything else is rejected here
 * before it reaches Storage.
 *
 * COMPLETO.json — format published by the external editor v3 (reported by Codex from editor.py, lines
 * 1342–1345, and podcast_editor/storage.py → publish). Read from salida/COMPLETO.json:
 *
 *   { "episode_id": "<same as path>", "assembly_version": <same as path>, "estado": "completo",
 *     "editor_version": "…", "job_key": "…", "manifest_sha256": "<64 hex>", "publicado_en": "<ISO date>",
 *     "verificacion": "completa" | "sidecar",
 *     "objetos": [ { "key": "<path inside the episode/version>", "size": <bytes>, "sha256": "<64 hex>" } ] }
 *
 * Object keys may be full bucket keys (episodios/<ep>/v<n>/…) or relative to the version folder; both are
 * normalised to the relative form and must be one of: salida/<file>, salida/muestras/<file>,
 * estado/reporte-<…>.json. Anything else — another episode/version, entrada/, traversal, empty segments,
 * duplicates — rejects the whole delivery. Parsing fails closed.
 */
export const EDITOR_BUCKET = "podcast-editor";
export const COMPLETE_MARKER = "COMPLETO.json";

const EPISODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const VERSION_SEGMENT = /^v[1-9][0-9]{0,8}$/;
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

export type DeclaredOutput = { key: string; size: number; sha256: string };
export type CompleteManifest = {
  episodeId: string; version: number; editorVersion: string; jobKey: string; manifestSha256: string; publishedAt: string;
  objetos: DeclaredOutput[];
};

export type ManifestResult = { ok: true; manifest: CompleteManifest } | { ok: false; reason: string };

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const ALLOWED_KEY = [/^salida\/[^/]+$/, /^salida\/muestras\/[^/]+$/, /^estado\/reporte-[^/]+\.json$/];

/**
 * Normalises one declared key to "<area>/…" inside the expected episode/version, or null when it points
 * anywhere else (other episode/version, entrada/, traversal, odd segments, the marker itself).
 */
export function normaliseObjectKey(key: unknown, episodeId: string, version: number): string | null {
  if (typeof key !== "string" || key.length === 0 || key.length > 400) return null;
  const prefix = `${versionFolder(episodeId, version)}/`;
  let rel = key;
  if (key.startsWith("episodios/")) {
    if (!key.startsWith(prefix)) return null;
    rel = key.slice(prefix.length);
  }
  const segments = rel.split("/");
  if (segments.some((seg) => !SEGMENT.test(seg) || seg.includes(".."))) return null;
  if (!ALLOWED_KEY.some((re) => re.test(rel))) return null;
  if (rel === `salida/${COMPLETE_MARKER}`) return null;
  return rel;
}

/** Strict parse of the editor v3 COMPLETO.json for the expected episode/version (format above). */
export function parseCompleteManifest(raw: string, expected: { episodeId: string; version: number }): ManifestResult {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { ok: false, reason: "COMPLETO.json no es JSON válido" }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "COMPLETO.json no es un objeto" };
  const d = data as Record<string, unknown>;
  if (d.estado !== "completo") return { ok: false, reason: "COMPLETO.json no declara estado \"completo\"" };
  if (d.episode_id !== expected.episodeId) return { ok: false, reason: "COMPLETO.json declara otro episodio" };
  if (d.assembly_version !== expected.version) return { ok: false, reason: "COMPLETO.json declara otra versión" };
  if (typeof d.editor_version !== "string" || !d.editor_version.trim() || d.editor_version.length > 64) return { ok: false, reason: "COMPLETO.json sin editor_version" };
  if (typeof d.job_key !== "string" || !d.job_key.trim() || d.job_key.length > 200) return { ok: false, reason: "COMPLETO.json sin job_key" };
  if (typeof d.manifest_sha256 !== "string" || !SHA256.test(d.manifest_sha256)) return { ok: false, reason: "COMPLETO.json con manifest_sha256 inválido" };
  if (typeof d.publicado_en !== "string" || Number.isNaN(Date.parse(d.publicado_en))) return { ok: false, reason: "COMPLETO.json sin publicado_en válido" };
  if (d.verificacion !== "completa" && d.verificacion !== "sidecar") return { ok: false, reason: "COMPLETO.json con verificacion inválida" };
  if (!Array.isArray(d.objetos) || d.objetos.length === 0) return { ok: false, reason: "COMPLETO.json no declara objetos" };
  if (d.objetos.length > 500) return { ok: false, reason: "COMPLETO.json declara demasiados objetos" };
  const seen = new Set<string>();
  const objetos: DeclaredOutput[] = [];
  for (const item of d.objetos) {
    if (!item || typeof item !== "object") return { ok: false, reason: "objeto mal formado" };
    const { key, size, sha256 } = item as Record<string, unknown>;
    const rel = normaliseObjectKey(key, expected.episodeId, expected.version);
    if (!rel) return { ok: false, reason: "ruta de objeto no permitida" };
    if (seen.has(rel)) return { ok: false, reason: `objeto repetido: ${rel}` };
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return { ok: false, reason: `tamaño inválido en ${rel}` };
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) return { ok: false, reason: `sha256 inválido en ${rel}` };
    seen.add(rel);
    objetos.push({ key: rel, size, sha256 });
  }
  return { ok: true, manifest: {
    episodeId: expected.episodeId, version: expected.version, editorVersion: d.editor_version, jobKey: d.job_key,
    manifestSha256: d.manifest_sha256, publishedAt: d.publicado_en, objetos,
  } };
}

/** Prefer the episode video; editor publish sorts episodio.mp3 before episodio.mp4. Audio is a fallback. */
export function primaryMedia(objetos: DeclaredOutput[]): DeclaredOutput | null {
  return objetos.find((o) => /^salida\/[^/]+\.(mp4|webm)$/i.test(o.key))
    ?? objetos.find((o) => /^salida\/[^/]+\.(m4a|mp3|wav)$/i.test(o.key)) ?? null;
}
