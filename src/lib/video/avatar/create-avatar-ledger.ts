/**
 * T46 D2/D6: createAvatar under the paid-call ledger AND the atomic supply admission.
 *
 * The photo claim excludes most duplicate submits, while the ledger's unique key and RESERVED→SUBMITTED CAS ensure
 * that concurrent contenders reach the provider at most once. D6 adds the economic precondition that D2 originally
 * bypassed: the provider call is impossible unless a positive, operator-verified creation price is configured and
 * the LedgerStore exposes its atomic supply submit hook.
 *
 * The configured amount is an exact accounting input for this operation, not a guessed default. If the provider's
 * contract does not expose a trustworthy per-creation price, the feature stays fail-closed.
 */
import { guardPaidCall, type LedgerStore, type PaidCallClassification } from "@/lib/paid-calls/gate";
import { ledgerBillableUsd } from "@/lib/paid-calls/ledger-usd";
import { SupplyUnavailableError } from "@/lib/supply/policy";
import { AvatarProviderError } from "@/lib/providers/types";
import { isFinalAvatarCreationRejection, type ProviderAvatar } from "./new-photo-claim";

const PRICE_ENV: Readonly<Record<string, string>> = {
  heygen: "PRICING_HEYGEN_CREATE_AVATAR_USD",
  did: "PRICING_DID_CREATE_AVATAR_USD",
};

function configurationError(providerName: string, detail: string, cause?: unknown): AvatarProviderError {
  return new AvatarProviderError(
    `No se pudo verificar el costo de creación del avatar (${detail}). No se llamó al proveedor.`,
    providerName,
    "not_configured",
    cause,
  );
}

/** A missing, zero, negative or malformed rate is UNKNOWN and blocks before any provider call. */
export function configuredAvatarCreationCostUsd(
  providerName: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const name = PRICE_ENV[providerName];
  if (!name) throw configurationError(providerName, "proveedor sin tarifa autorizada");
  const raw = env[name];
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || !(parsed > 0)) throw configurationError(providerName, `${name} ausente o inválida`);
  // pi_paid_operations es numeric(12,4): se reserva el importe redondeado HACIA ARRIBA a 0.0001 (reserva contable,
  // no costo exacto). Un valor que desborda numeric(12,4) es inválido y bloquea antes del proveedor.
  try {
    return ledgerBillableUsd(parsed, name);
  } catch (cause) {
    throw configurationError(providerName, `${name} no representable en el ledger`, cause);
  }
}

export function avatarCreationSpec(
  requestId: string,
  providerName: string,
  photoSha256: string,
  verifiedCostUsd: number,
) {
  if (!Number.isFinite(verifiedCostUsd) || !(verifiedCostUsd > 0))
    throw configurationError(providerName, "tarifa no positiva");
  return {
    projectId: requestId,
    shotId: "avatar:create",
    provider: providerName,
    model: "photo-asset",
    method: "create_avatar",
    inputFingerprint: { photoSha256 },
    reservedUsd: verifiedCostUsd,
  };
}

export async function ledgerGuardedCreateAvatar(
  ledger: LedgerStore,
  requestId: string,
  providerName: string,
  photoSha256: string,
  call: () => Promise<ProviderAvatar>,
  controls: { verifiedCostUsd?: number } = {},
): Promise<ProviderAvatar> {
  const verifiedCostUsd = controls.verifiedCostUsd ?? configuredAvatarCreationCostUsd(providerName);
  if (!ledger.submit) throw configurationError(providerName, "admisión económica no disponible");

  try {
    const guarded = await guardPaidCall<ProviderAvatar>(
      ledger,
      avatarCreationSpec(requestId, providerName, photoSha256, verifiedCostUsd),
      {
        call: async () => {
          const result = await call();
          return {
            result,
            costUsd: verifiedCostUsd,
            resultRef: `avatar:${JSON.stringify(result)}`,
          };
        },
        load: async ref => (ref.startsWith("avatar:") ? JSON.parse(ref.slice(7)) as ProviderAvatar : null),
        classify: (err): PaidCallClassification =>
          (isFinalAvatarCreationRejection(err) ? { kind: "rejected_final" } : { kind: "uncertain" }),
      },
    );
    return guarded.result;
  } catch (error) {
    // submitWithSupply fails before the provider call. Mark it as a definitive local refusal so the photo claim can
    // be released safely; no external effect is uncertain in this branch.
    if (error instanceof SupplyUnavailableError)
      throw new AvatarProviderError(
        "No hay presupuesto o capacidad verificada para crear el avatar. No se llamó al proveedor.",
        providerName,
        "budget_exceeded",
        error,
      );
    throw error;
  }
}
