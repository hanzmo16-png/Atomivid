/**
 * Avatar from a NEW photo, at most once per request (PR #149 corrección 2, residual A, 2026-10-18).
 *
 * The provider's createAvatar runs BEFORE the request row exists, so the row's primary key cannot stop a second
 * identical submit from creating a second avatar at the provider. The claim is the photo itself: it is stored at a
 * path derived from the request id (`<user>/<requestId>.<ext>`, see photoClaimPath) with upsert disabled, so the
 * storage's unique object name is the durable, server-side authority — taken BEFORE the first external effect:
 *   - upload wins → this submit owns the claim and is the only one that may call createAvatar;
 *   - the object already exists and an avatar row points at it → reuse it (resend after a lost or uncertain
 *     response): 0 provider calls;
 *   - it exists without a row and is recent → another submit is creating it right now: 0 calls, say so;
 *   - it exists without a row and is older than STALE_CLAIM_MS → an earlier submit never confirmed; it may have
 *     created an avatar at the provider. Nothing is repeated automatically: 0 calls, the customer is told, and the
 *     existing intent stays blocked until an operator reconciles it.
 * A provider REFUSAL releases the claim (the photo is removed, as before); an avatar created but not recorded keeps it.
 */
import { AvatarProviderError } from "@/lib/providers/types";

export const STALE_CLAIM_MS = 10 * 60 * 1000;

export function photoClaimPath(userId: string, requestId: string, format: string): string {
  return `${userId}/${requestId}.${format}`;
}

export type AvatarRow = { id: string; status: string };
export type ProviderAvatar = { providerAvatarId: string; providerJobId?: string; status: string; providerName: string };

export type NewPhotoClaimDeps = {
  /** Upload with upsert disabled. `duplicate` must be true only when the object already exists. */
  upload(path: string): Promise<{ ok: true } | { ok: false; duplicate: boolean; message: string }>;
  findAvatarByPhoto(path: string): Promise<AvatarRow | null>;
  /** When the claim object was created, or null if it cannot be read (treated as recent: never repeat). */
  claimCreatedAt(path: string): Promise<Date | null>;
  removePhoto(path: string): Promise<void>;
  createAvatar(): Promise<ProviderAvatar>;
  insertAvatar(provider: ProviderAvatar, path: string): Promise<AvatarRow | null>;
  now?: () => number;
};

export type NewPhotoClaimResult =
  | { kind: "created"; avatar: AvatarRow } | { kind: "reused"; avatar: AvatarRow }
  | { kind: "in_flight" } | { kind: "stale" } | { kind: "not_recorded" }
  | { kind: "upload_failed"; message: string } | { kind: "provider_failed"; message: string }
  | { kind: "uncertain" };

export async function createAvatarOnce(deps: NewPhotoClaimDeps, path: string): Promise<NewPhotoClaimResult> {
  const up = await deps.upload(path);
  if (!up.ok) {
    if (!up.duplicate) return { kind: "upload_failed", message: up.message };
    const existing = await deps.findAvatarByPhoto(path);
    if (existing) return { kind: "reused", avatar: existing };
    const created = await deps.claimCreatedAt(path).catch(() => null);
    const age = created ? (deps.now ?? Date.now)() - created.getTime() : 0;
    return { kind: age > STALE_CLAIM_MS ? "stale" : "in_flight" };
  }
  let provider: ProviderAvatar;
  try {
    provider = await deps.createAvatar();
  } catch (err) {
    // Only a definitive rejection BEFORE any provider-side action permits releasing the claim.
    // A network/timeout/5xx/invalid response can mean HeyGen already accepted the photo.
    // Keep the claim on uncertain outcomes so a resend cannot call createAvatar again.
    if (isFinalAvatarCreationRejection(err)) {
      await deps.removePhoto(path).catch(() => {});
      return { kind: "provider_failed", message: err instanceof Error ? err.message : "El proveedor rechazó la solicitud" };
    }
    return { kind: "uncertain" };
  }
  const row = await deps.insertAvatar(provider, path).catch(() => null);
  // The provider created it but it is not recorded: keep the claim, so a resend never creates a second one.
  return row ? { kind: "created", avatar: row } : { kind: "not_recorded" };
}

/** Only these explicit local/provider-final refusals are known not to have created a resource. */
export function isFinalAvatarCreationRejection(error: unknown): boolean {
  return error instanceof AvatarProviderError &&
    (error.reason === "not_configured" || error.reason === "consent_missing" ||
      error.reason === "budget_exceeded" || error.reason === "moderation_rejected" || error.reason === "circuit_open");
}

/** Customer messages; none of them says «no se cobró nada» (the provider may have acted). */
export const CLAIM_MESSAGES = {
  in_flight: "Esta misma solicitud ya se está procesando (en otra pestaña o en un envío anterior). No se creó otro avatar. Revisa tu panel en unos segundos.",
  stale: "Un envío anterior de esta misma solicitud no se confirmó y pudo haber creado un avatar en el proveedor. No se repitió y esta solicitud permanece bloqueada para evitar otro posible cobro. Contacta a soporte para conciliarla antes de crear otro avatar.",
  not_recorded: "El avatar se creó en el proveedor pero no se pudo guardar. No se repetirá automáticamente; escríbenos para recuperarlo.",
  uncertain: "No pudimos confirmar si el proveedor recibió la fotografía. Conservamos esta solicitud y no intentaremos crear otro avatar automáticamente. Contacta a soporte para conciliarla.",
} as const;

/** Supabase Storage reports an existing object as 409 / «already exists» / «Duplicate». */
export function isDuplicateUpload(error: { message?: string; statusCode?: string | number; status?: number } | null): boolean {
  if (!error) return false;
  return String(error.statusCode ?? error.status ?? "") === "409" || /already exists|duplicate/i.test(error.message ?? "");
}
