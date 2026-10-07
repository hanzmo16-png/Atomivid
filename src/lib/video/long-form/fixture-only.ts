/**
 * Material FIXTURE_ONLY / TEST_ONLY (benchmarks visuales: sintético, propio,
 * local). Nunca es un recurso documental verificado y nunca puede entrar en
 * una solicitud real: el cargador de producción lo rechaza antes de gastar.
 */
export const FIXTURE_ONLY_MARKER = "fixture-only";

const marked = (v: unknown) => typeof v === "string" && v.toLowerCase().includes(FIXTURE_ONLY_MARKER);

/** ¿Algún recurso del archivo de curaduría (o cualquier objeto) lleva la marca FIXTURE_ONLY? */
export function containsFixtureOnlyMaterial(raw: unknown): boolean {
  const assets = raw && typeof raw === "object" ? (raw as { assets?: unknown }).assets : undefined;
  if (!Array.isArray(assets)) return false;
  return assets.some((a) => {
    const asset = a && typeof a === "object" ? (a as Record<string, unknown>) : {};
    return [asset.id, asset.sourceUrl, asset.mediaUrl, asset.description].some(marked);
  });
}
