/**
 * Recovery budget of a documentary job (migration 20261008120000_documentary_recovery_budget.sql).
 * The cap is enforced INSIDE pi_submit_with_supply, atomically and before any provider call; this module
 * only turns its refusals into a clear, terminal error. A refusal is never "wait for supply": the job stops,
 * nothing is retried automatically, and the budget is never raised from the application.
 */
export const RECOVERY_BUDGET_REASONS = ["recovery budget exceeded", "recovery budget closed", "recovery budget: cost unverified"] as const;

export class RecoveryBudgetExceededError extends Error {
  readonly reason: string;
  readonly capUsd?: number;
  readonly committedUsd?: number;
  readonly pendingUsd?: number;
  readonly requestedUsd?: number;
  constructor(result: { reason: string; capUsd?: unknown; committedUsd?: unknown; pendingUsd?: unknown; requestedUsd?: unknown }) {
    super(`RECOVERY_BUDGET: ${result.reason}`);
    this.name = "RecoveryBudgetExceededError";
    this.reason = result.reason;
    const n = (v: unknown) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? undefined : Number(v));
    this.capUsd = n(result.capUsd);
    this.committedUsd = n(result.committedUsd);
    this.pendingUsd = n(result.pendingUsd);
    this.requestedUsd = n(result.requestedUsd);
  }
  get customerMessage(): string {
    const cap = this.capUsd === undefined ? "" : ` (USD ${this.capUsd.toFixed(2)})`;
    if (this.reason === "recovery budget closed") return `El presupuesto de recuperación de este guion está cerrado${cap}. No se hizo ninguna llamada nueva.`;
    return `Se alcanzó el presupuesto autorizado para recuperar este guion${cap}. No se hizo ninguna llamada nueva; ` +
      "el guion y las respuestas pagadas están guardados. Continuar requiere una nueva autorización de gasto.";
  }
}

export function isRecoveryBudgetRefusal(reason: unknown): boolean {
  return typeof reason === "string" && (RECOVERY_BUDGET_REASONS as readonly string[]).includes(reason);
}
