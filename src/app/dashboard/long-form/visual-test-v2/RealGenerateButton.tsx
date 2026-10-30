"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { summarizeRealRunResponse, type RealRunDisplayState } from "@/lib/video/long-form/visual-test-v2-real-display";

/**
 * Generación real de las 3 imágenes del Visual Test V2. Los costos y el
 * token de autorización los calcula el servidor y llegan como props de
 * solo lectura. El primer click solo abre la confirmación visible; el
 * POST ocurre después, con ese token. El servidor vuelve a exigir admin
 * y un token válido — este componente no puede autorizar el gasto solo.
 */
export function RealGenerateButton({
  shotIds,
  estimatedTotalUsd,
  maxTotalUsd,
  spendAuthorizationToken,
}: {
  shotIds: readonly string[];
  estimatedTotalUsd: number;
  maxTotalUsd: number;
  spendAuthorizationToken: string;
}) {
  const [armed, setArmed] = useState(false);
  const [state, setState] = useState<RealRunDisplayState>({ kind: "idle" });
  const maxLabel = `US$${maxTotalUsd.toFixed(2)}`;

  async function runReal() {
    setState({ kind: "loading" });
    let httpStatus: number;
    let body: unknown;
    try {
      const res = await fetch("/api/long-form/visual-test-v2/real", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: spendAuthorizationToken }),
      });
      httpStatus = res.status;
      body = await res.json().catch(() => null);
    } catch {
      setState({ kind: "error", httpStatus: 0, message: "No se pudo contactar al servidor. Intenta de nuevo." });
      return;
    }
    setState(summarizeRealRunResponse(httpStatus, body));
  }

  return (
    <div className="space-y-4 rounded-lg border-2 border-danger/40 p-4">
      <div className="space-y-1 text-sm">
        <p className="font-semibold text-ink">Generación REAL (dinero real — OpenAI Images)</p>
        <p>
          {shotIds.length} imágenes: {shotIds.join(", ")}
        </p>
        <p>Costo estimado: US${estimatedTotalUsd.toFixed(2)}</p>
        <p>Máximo autorizado: {maxLabel}</p>
      </div>

      {!armed ? (
        <Button type="button" variant="secondary" onClick={() => setArmed(true)}>
          Revisar costo antes de generar — máximo {maxLabel}
        </Button>
      ) : (
        <div
          role="alertdialog"
          aria-labelledby="vt2-spend-confirm-title"
          aria-describedby="vt2-spend-confirm-body"
          className="space-y-3 rounded-lg border border-danger/50 bg-surface p-4"
        >
          <p id="vt2-spend-confirm-title" className="font-semibold text-ink">
            Confirmación de gasto
          </p>
          <p id="vt2-spend-confirm-body" className="text-sm">
            Vas a generar {shotIds.length} imágenes reales. El máximo es {maxLabel}. Esto consume dinero real y el
            servidor volverá a comprobar la autorización antes de llamar al proveedor.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="danger" onClick={runReal} loading={state.kind === "loading"}>
              Generar 3 imágenes — máximo US$0.50
            </Button>
            <Button type="button" variant="ghost" onClick={() => setArmed(false)} disabled={state.kind === "loading"}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <p role="alert" className="text-sm text-danger">
          Error (estado {state.httpStatus}): {state.message}
        </p>
      )}

      {state.kind === "result" && (
        <div role="status" className="space-y-3 rounded-lg border border-border-strong p-4 text-sm">
          <ul className="list-disc space-y-1 pl-5">
            {state.shots.map((shot) => (
              <li key={shot.shotId}>
                {shot.shotId} — {shot.status === "generated" ? "generada ahora" : shot.status === "reused" ? "reutilizada (ya existía)" : "estado desconocido"} — costo: ${shot.costUsd.toFixed(4)}
              </li>
            ))}
          </ul>
          <p>
            <strong>Gastado en esta ejecución:</strong> ${state.totalSpentThisRunUsd.toFixed(4)}
          </p>
          <p>
            <strong>Total acumulado Visual Test V2:</strong> ${state.ledgerVisualTestV2SpentUsd.toFixed(4)} / ${state.maxTotalUsd.toFixed(2)}
          </p>
          <p>
            <strong>Total acumulado VIDEO #001:</strong> ${state.ledgerTotalSpentUsd.toFixed(4)} / ${state.hardStopUsd.toFixed(2)}
          </p>
          <p>
            <strong>Llamadas pagadas realizadas:</strong> {state.paidApisCalled ? "true" : "false"}
          </p>
        </div>
      )}
    </div>
  );
}
