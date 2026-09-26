/**
 * Ejecución SERIAL de las muestras reales (scripts/audiovisual-samples.ts)
 * con el presupuesto global recalculado ANTES de cada muestra.
 *
 * El plan impreso al inicio es solo informativo: la decisión que autoriza
 * gastar se vuelve a calcular inmediatamente antes de cada muestra, a partir
 * del comprometido RELEÍDO de los registros durables (lo que acaba de gastar
 * la muestra anterior incluido). El tope efectivo resultante es el que recibe
 * el registro de la muestra, así que ninguna operación puede llevar el total
 * por encima del límite global aunque la estimación se quede corta.
 */
import type { PaidLedger } from "./paid-ledger";
import { sampleBudgetDecision, type BudgetCaps, type SampleEstimate } from "./sample-plan";

export type SampleDecision = ReturnType<typeof sampleBudgetDecision>;

export class SampleBudgetStopError extends Error {
  constructor(public readonly sampleId: string, public readonly decision: SampleDecision) {
    super(`Muestra ${sampleId} no arranca: ${decision.reason}. Detenido.`);
    this.name = "SampleBudgetStopError";
  }
}

export async function runSamplesSerially(input: {
  sampleIds: string[];
  caps: BudgetCaps;
  estimates: Record<string, SampleEstimate>;
  /** Comprometido de TODAS las muestras, leído de nuevo desde los registros durables en cada llamada. */
  loadCommitted: () => Promise<Record<string, number>>;
  /** Abre el registro durable de la muestra con el tope efectivo recién calculado. */
  openLedger: (sampleId: string, capUsd: number) => Promise<PaidLedger>;
  produce: (sampleId: string, ledger: PaidLedger, decision: SampleDecision) => Promise<void>;
  log?: (event: string, data: Record<string, unknown>) => void;
}): Promise<{ committedBySample: Record<string, number> }> {
  // Serial a propósito: cada decisión depende del gasto real de la anterior.
  for (const sampleId of input.sampleIds) {
    const committedBySample = await input.loadCommitted();
    const decision = sampleBudgetDecision({ caps: input.caps, committedBySample, sampleId, estimate: input.estimates[sampleId] });
    input.log?.("DECISION", { sample: sampleId, committedBySample, ...decision });
    if (!decision.start) throw new SampleBudgetStopError(sampleId, decision);
    const ledger = await input.openLedger(sampleId, decision.effectiveCapUsd);
    await input.produce(sampleId, ledger, decision);
  }
  return { committedBySample: await input.loadCommitted() };
}
