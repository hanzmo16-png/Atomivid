import { InvalidEnvVarError } from "@/lib/env-errors";

/** Stored on creation, before the first script call; changing env never raises an existing Reel's cap. */
export function reelProviderSpendCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.REEL_MAX_PROVIDER_SPEND_USD ?? "1.50";
  const cap = Number(raw);
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/.test(raw) || !(cap > 0 && cap <= 25))
    throw new InvalidEnvVarError("REEL_MAX_PROVIDER_SPEND_USD", "USD positivos, hasta 25 y con un máximo de cuatro decimales");
  return cap;
}

export class ReelBudgetExceededError extends Error {
  readonly customerMessage: string;
  constructor(readonly reason: string, capUsd?: unknown) {
    super(reason);
    this.name = "ReelBudgetExceededError";
    const cap = typeof capUsd === "number" && Number.isFinite(capUsd) ? ` (USD ${capUsd.toFixed(2)})` : "";
    this.customerMessage = (reason === "reel budget exceeded"
      ? `El siguiente paso superaría el presupuesto total de este Reel${cap}. `
      : reason === "reel budget: project id noncanonical"
        ? "No se pudo verificar el presupuesto de esta solicitud. "
        : "No se pudo verificar el costo del siguiente paso de este Reel. ")
      + "No se hizo ninguna llamada nueva. El guion, los archivos y los gastos anteriores se conservan; contacta al soporte antes de continuar.";
  }
}

export const isReelBudgetRefusal = (reason: unknown): reason is string =>
  reason === "reel budget exceeded" || reason === "reel budget: cost unverified" || reason === "reel budget: project id noncanonical";
