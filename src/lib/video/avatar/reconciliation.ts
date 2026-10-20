/**
 * T46 D3: pure classification for read-only avatar-creation reconciliation.
 *
 * This module NEVER settles a ledger row and NEVER calls a provider. Missing
 * local evidence is not proof that a provider rejected a request.
 */
export type AvatarCreationReconciliationEvidence = {
  readsComplete: boolean;
  method: string;
  status: string;
  providerJobPresent: boolean;
  resultRefPresent: boolean;
  claimPresent: boolean;
  matchingAvatarRows: number;
  providerAvatarPresent: boolean;
  requestPresent: boolean;
};

export type AvatarCreationReconciliationVerdict =
  | "already_settled"
  | "candidate_success_needs_approval"
  | "needs_provider_review"
  | "unknown_read_failure"
  | "invalid_scope";

export type AvatarCreationReconciliationDecision = {
  verdict: AvatarCreationReconciliationVerdict;
  mayResubmit: false;
  maySettleAutomatically: false;
  reason: string;
};

export function classifyAvatarCreationEvidence(
  evidence: AvatarCreationReconciliationEvidence,
): AvatarCreationReconciliationDecision {
  const base = { mayResubmit: false as const, maySettleAutomatically: false as const };
  if (!evidence.readsComplete) {
    return { ...base, verdict: "unknown_read_failure", reason: "Una lectura falló; el intento permanece bloqueado." };
  }
  if (evidence.method !== "create_avatar") {
    return { ...base, verdict: "invalid_scope", reason: "La operación no pertenece a create_avatar." };
  }
  if (evidence.status === "COMMITTED" || evidence.status === "REFUNDED") {
    return { ...base, verdict: "already_settled", reason: "El ledger ya está liquidado; no se modifica." };
  }
  if (!["SUBMITTED", "RECONCILIATION_REQUIRED", "PROVIDER_JOB_RECORDED"].includes(evidence.status)) {
    return { ...base, verdict: "invalid_scope", reason: "El estado no es conciliable por este colector." };
  }
  if (evidence.matchingAvatarRows > 1) {
    return { ...base, verdict: "unknown_read_failure", reason: "Hay evidencia local ambigua; requiere revisión manual." };
  }
  if (evidence.matchingAvatarRows === 1 && evidence.providerAvatarPresent) {
    return {
      ...base,
      verdict: "candidate_success_needs_approval",
      reason: "Existe un avatar local con identificador del proveedor; verificarlo externamente y aprobar un CAS separado.",
    };
  }
  return {
    ...base,
    verdict: "needs_provider_review",
    reason: "La evidencia local no demuestra rechazo ni éxito; consultar al proveedor sin reenviar.",
  };
}
