/**
 * USD 0 auditor for local runs, dry runs and tests: same contract as the OpenAI auditor, no network.
 * Either scripted (a queue of verdicts) or a simple deterministic rule: a delivery that states "verificación:" with
 * evidence is approved; otherwise a revision asking for verifiable evidence.
 */
import type { AuditVerdict, Auditor, AuditUsage } from "./types";

export class SimulatedAuditor implements Auditor {
  readonly name = "simulado";
  readonly paid = false;
  calls = 0;
  constructor(private script: (AuditVerdict | Error | unknown)[] = []) {}

  async audit(input: { task: string; delivery: string; attempt: number; maxAttempts: number }): Promise<{ verdict: AuditVerdict; usage: AuditUsage }> {
    this.calls++;
    const usage: AuditUsage = { inputTokens: Math.ceil((input.task.length + input.delivery.length) / 3), outputTokens: 150, costUsd: 0, model: "simulado" };
    if (this.script.length) {
      const next = this.script.shift();
      if (next instanceof Error) throw next;
      return { verdict: next as AuditVerdict, usage };
    }
    const evidence = /verificaci[oó]n:\s*\S+/i.test(input.delivery);
    return {
      verdict: evidence
        ? { decision: "approve", summary: "La entrega incluye verificación explícita.", instructions: [], findings: [], requires_human_approval: false }
        : { decision: "revise", summary: "Falta evidencia verificable.", instructions: ["Añade una línea «verificación:» con la evidencia concreta (archivo, ID o resultado comprobable)."], findings: ["sin verificación"], requires_human_approval: false },
      usage,
    };
  }
}
