/**
 * Guion de las muestras con registro de gasto POR LLAMADA real.
 *
 * Cada llamada a Claude (primer borrador, cada corrección de longitud y cada
 * reintento permitido) es una entrada propia del registro durable:
 * reservada antes de llamar, liquidada con los tokens medidos del `usage` o
 * marcada como incierta si pudo cobrarse sin respuesta. Así el registro
 * refleja cuántas llamadas se hicieron de verdad, no una sola estimación
 * por generación.
 *
 * Bloqueo por generación: si cualquier llamada de guion de la muestra quedó
 * incierta, reservada o pagada sin guion guardado (y no se recuperó
 * explícitamente), no se empieza otra generación.
 */
import { scriptCallFailureOutcome } from "@/lib/ai/script";
import type { ScriptCallRunner } from "@/lib/providers/types";
import { UncertainPaidOperationError, type PaidEntry, type PaidLedger } from "./paid-ledger";
import { scriptCallReserveUsd, scriptUsageCostUsd } from "./paid-costs";

/** Prefijo de las operaciones de guion de una muestra/solicitud. */
export function scriptScope(scopePrefix: string): string {
  return `script:${scopePrefix}`;
}

function latestUnder(ledger: PaidLedger, scope: string): PaidEntry[] {
  const latest = new Map<string, PaidEntry>();
  for (const e of ledger.snapshot().entries) if (e.key === scope || e.key.startsWith(`${scope}/`)) latest.set(e.key, e);
  return [...latest.values()];
}

/** Entradas de guion que siguen bloqueando (no liberadas y no recuperadas). */
export function blockingScriptEntries(ledger: PaidLedger, scope: string): PaidEntry[] {
  return latestUnder(ledger, scope).filter((e) => e.status !== "released" && !e.acknowledgedAtIso);
}

export function assertScriptGenerationClear(ledger: PaidLedger, scope: string): void {
  const blocking = blockingScriptEntries(ledger, scope);
  if (blocking.length > 0) {
    const first = blocking[0];
    throw new UncertainPaidOperationError(
      first.key,
      `${blocking.length} llamada(s) de guion anteriores sin guion guardado (${blocking.map((e) => e.status).join(", ")}); requiere recuperación explícita del grupo «${scope}»`,
    );
  }
}

/**
 * Envoltorio de cada llamada real con su propia entrada del registro. Las
 * claves son únicas y crecientes (`<scope>/<hash>/call-N`), contando las
 * llamadas ya registradas, así un intento posterior nunca reutiliza una
 * clave.
 */
export function ledgeredScriptRunner(ledger: PaidLedger, scope: string, generationKey: string, attempt?: number): ScriptCallRunner {
  let seq = latestUnder(ledger, scope).length;
  return async (meta, call) => {
    seq += 1;
    return ledger.run(
      {
        key: `${scope}/${generationKey}/call-${seq}`,
        kind: "script",
        provider: "anthropic",
        reserveUsd: scriptCallReserveUsd(meta.promptChars, meta.maxTokens),
        label: `guion: llamada ${meta.call} (longitud ${meta.lengthAttempt})`,
        units: { inputChars: meta.promptChars },
      },
      async () => {
        const value = await call();
        const stop = (value as { stop_reason?: unknown }).stop_reason;
        const blocks = (value as { content?: { type?: unknown }[] }).content?.map((b) => String(b.type)).join(",");
        const meta2 = `stop_reason=${String(stop ?? "desconocido")}; bloques=${blocks || "ninguno"}`;
        if (!value.usage) return { value, settle: { costBasis: "estimated" as const, note: `sin usage; liquidado por la reserva; ${meta2}` } };
        return {
          value,
          settle: {
            actualUsd: scriptUsageCostUsd(value.usage),
            costBasis: "provider_usage" as const,
            note: `tokens medidos in=${value.usage.input_tokens} out=${value.usage.output_tokens}; ${meta2}`,
          },
        };
      },
      (err) => (scriptCallFailureOutcome(err) === "uncertain" ? "uncertain" : "not_sent"),
      attempt,
    );
  };
}
