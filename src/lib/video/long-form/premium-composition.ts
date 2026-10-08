/**
 * Premium Composition V1 — puertas del lado del servidor para las primitivas
 * compartidas del renderer (remotion/long-form-direction.ts). Ninguna crea
 * contenido: solo deciden si un recurso YA verificado puede recibir una
 * presentación determinista.
 */
import { createHash } from "node:crypto";
import { prepareCuratedSvg } from "../../../../remotion/long-form-direction";
import type { LongFormCuratedSvgGraphic } from "../../../../remotion/LongFormDoc";
import { VerifiedAssetRegistry, type VerifiedAssetRecord } from "./verified-assets";

/**
 * SVG curado → escena de revelado, o null (sin animación). Exige un registro
 * de CONFIANZA (emitido por la rehidratación del servidor), MIME SVG y los ids
 * aprobados del trazo y la etiqueta; el renderer solo anima esos dos elementos,
 * que ya existen en el SVG. Nada se infiere (ni geografía, ni tropas, ni rutas).
 */
export function curatedSvgGraphic(record: VerifiedAssetRecord | null | undefined, markup: string, opts: { title?: string; isFixture?: boolean } = {}): LongFormCuratedSvgGraphic | null {
  if (!record || !VerifiedAssetRegistry.isTrusted(record)) return null;
  if (record.mime !== "image/svg+xml" || !record.svgReveal) return null;
  // Mutación: si el registro conoce el SHA-256 del SVG aprobado, el contenido debe ser exactamente ese.
  if (record.contentSha256 && createHash("sha256").update(markup).digest("hex") !== record.contentSha256) return null;
  const svg = prepareCuratedSvg(markup, record.svgReveal);
  if (!svg) return null;
  return { kind: "curated_svg", ...(opts.title ? { title: opts.title } : {}), svg, isFixture: opts.isFixture ?? false };
}
