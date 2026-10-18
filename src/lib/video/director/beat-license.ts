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

const RANK: Readonly<Record<MediaLicense, number>> = Object.freeze({ CLEARED: 0, NEEDS_REVIEW: 1, NOT_CLEARED: 2 });
/** T36 C2: strict comparison with the three literals — the `in` operator also accepted inherited names (toString…). */
const isLicense = (x: unknown): x is MediaLicense => x === "CLEARED" || x === "NEEDS_REVIEW" || x === "NOT_CLEARED";

/**
 * The strictest of the given verdicts; any explicit value that is not one of the three verdicts counts as NEEDS_REVIEW.
 * An absent declaration (`undefined`) is not a verdict: it keeps the provider's (contract unchanged in C2).
 */
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

/**
 * T36 C2 — a per-result block happens AFTER the narration was synthesized (footage needs its timings). The message
 * therefore never says "nothing was charged": it states what was already generated, its cost and that the attempt
 * needs reconciliation. Nothing is refunded automatically.
 */
const LICENSE_WORDS: Readonly<Record<MediaLicense, string>> = Object.freeze({ CLEARED: "autorizada", NEEDS_REVIEW: "pendiente de revisión", NOT_CLEARED: "no autorizada" });

/** Plain words only: the stored error message is sanitized and upper-case codes would show as "[configuración interna]". */
export function licenseBlockAfterVoiceMessage(scene: number, license: MediaLicense, voice: { calls: number; costUsd: number }): string {
  const spent = voice.costUsd > 0
    ? `: ese consumo (aprox. USD ${voice.costUsd.toFixed(2)}) cuenta en tu saldo, no se reembolsa automáticamente y queda pendiente de conciliación con soporte.`
    : " (sin costo en este intento).";
  return `El Director no pudo montar este video sin inventar material: el material de la escena ${scene} tiene la licencia ${LICENSE_WORDS[license]} y no se usó. `
    + `La narración de este intento ya se había generado antes de detectarlo${spent} `
    + "Qué hacer: cambia esa escena del guion para que use otro material, o pide soporte para revisar la licencia. "
    + "No se publicó ningún video, ni con Director ni con montaje clásico.";
}

export function footageResultLicense(provider: Pick<FootageProvider, "name" | "license"> | null | undefined, result: Pick<FootageResult, "license">): MediaLicense {
  return strictestLicense(footageProviderLicense(provider), result.license);
}
