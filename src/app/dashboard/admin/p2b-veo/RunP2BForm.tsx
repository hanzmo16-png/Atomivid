"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { runP2BPillarTransportVeo, type RunP2BState } from "./actions";

export function RunP2BForm() {
  const [state, action, pending] = useActionState<RunP2BState, FormData>(runP2BPillarTransportVeo, { kind: "idle" });

  return (
    <form action={action} className="space-y-4 rounded-lg border border-border-strong p-5">
      <Button type="submit" loading={pending}>
        Ejecutar prueba Veo
      </Button>

      {state.kind === "unauthorized" && (
        <p role="alert" className="text-sm text-danger">
          No autorizado.
        </p>
      )}

      {state.kind === "result" && !state.result.preflightPassed && (
        <div role="alert" className="space-y-1 text-sm text-danger">
          <p className="font-semibold">Runtime pre-check FALLÓ — no se llamó a Google.</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {state.result.failures.map((f) => (
              <li key={f.check}>
                <strong>{f.check}:</strong> {f.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.kind === "result" && state.result.preflightPassed && state.result.success && (
        <div role="status" className="space-y-1 text-sm">
          <p className="font-semibold text-emerald-600">SUCCESS</p>
          <p>
            Costo real: ${state.result.actualCostUsd} — acumulado de misión: ${state.result.missionCumulativeSpendUsd.toFixed(2)} / $10.00
          </p>
          <p>Duración: {state.result.durationSeconds}s — providerJobId: {state.result.providerJobId ?? "N/A"}</p>
          <p>Validación: {state.result.validation.valid ? "válido" : `inválido (${state.result.validation.reason})`}</p>
          {state.result.canonicalStoragePath && <p>Storage canónico: {state.result.canonicalStoragePath}</p>}
          {state.result.storedLocallyAt && <p>Preservado localmente en: {state.result.storedLocallyAt}</p>}
          {state.result.storageWarning && <p className="text-amber-600">{state.result.storageWarning}</p>}
        </div>
      )}

      {state.kind === "result" && state.result.preflightPassed && !state.result.success && (
        <div role="alert" className="space-y-1 text-sm text-danger">
          <p className="font-semibold">FAILED</p>
          <p>
            {state.result.errorReason} ({state.result.errorProviderId}): {state.result.errorMessage}
          </p>
          {state.result.providerJobId && <p>Operation ID (Google ya la creó): {state.result.providerJobId}</p>}
          <p>Acumulado de misión (conservador): ${state.result.missionCumulativeSpendUsd.toFixed(2)} / $10.00</p>
        </div>
      )}
    </form>
  );
}
