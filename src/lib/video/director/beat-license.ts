/**
 * T36 C1 — licence of the material the Director may render, fail-closed.
 *
 * Only adapters whose licence terms were reviewed are CLEARED here (Pexels: free to use, the production basis; the
 * fixture: synthetic material we generate). Our own generated images are CLEARED by contract. Any other provider,
 * or a provider that is missing, is NEEDS_REVIEW. A provider (or one result) may declare a stricter verdict, never a
 * looser one: an unknown provider that calls itself CLEARED is still NEEDS_REVIEW.
 */
import type { FootageProvider, FootageResult, MediaLicense } from "@/lib/providers/types";

export const REVIEWED_FOOTAGE_LICENSES: Readonly<Record<string, MediaLicense>> = Object.freeze({
  "pexels-video-first": "CLEARED",
  fixture: "CLEARED",
});
export const GENERATED_IMAGE_LICENSE: MediaLicense = "CLEARED";

const RANK: Record<MediaLicense, number> = { CLEARED: 0, NEEDS_REVIEW: 1, NOT_CLEARED: 2 };
const isLicense = (x: unknown): x is MediaLicense => typeof x === "string" && x in RANK;

/** The strictest of the given verdicts; anything that is not a known verdict counts as NEEDS_REVIEW. */
export function strictestLicense(base: MediaLicense, ...declared: unknown[]): MediaLicense {
  return declared.filter((d) => d !== undefined).reduce<MediaLicense>((acc, d) => {
    const v = isLicense(d) ? d : "NEEDS_REVIEW";
    return RANK[v] > RANK[acc] ? v : acc;
  }, base);
}

export function footageProviderLicense(provider: Pick<FootageProvider, "name" | "license"> | null | undefined): MediaLicense {
  if (!provider) return "NEEDS_REVIEW";
  const reviewed = Object.hasOwn(REVIEWED_FOOTAGE_LICENSES, provider.name) ? REVIEWED_FOOTAGE_LICENSES[provider.name] : "NEEDS_REVIEW";
  return strictestLicense(reviewed, provider.license);
}

/** Same wording family as directorBlockMessage (rights category), without loading the Director bridge. */
export function licenseBlockMessage(scene: number, license: MediaLicense): string {
  return `El Director no pudo montar este video sin inventar material (LICENSE_NOT_CLEARED_FOR_RENDER): el material de la escena ${scene} tiene la licencia en estado ${license}. `
    + "Problema de derechos o licencia del material: no se usó. Qué hacer: cambia esa escena del guion para que use otro material, o pide soporte para revisar la licencia. "
    + "No se publicó ningún video con montaje clásico.";
}

export function footageResultLicense(provider: Pick<FootageProvider, "name" | "license"> | null | undefined, result: Pick<FootageResult, "license">): MediaLicense {
  return strictestLicense(footageProviderLicense(provider), result.license);
}
