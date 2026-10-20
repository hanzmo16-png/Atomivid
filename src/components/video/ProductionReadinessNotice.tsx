"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { ChecklistView, type CheckView } from "./ProductionChecklist";

/**
 * Control de costos (2026-10-18): «¿puedo hacer esta producción?» shown BEFORE the user presses anything,
 * as the same item-by-item checklist the new-video form shows.
 * Read-only: GET /api/generate/[id]/readiness never reserves, generates or calls a generative provider.
 * The start endpoints run the same check again on the server; this notice never authorises spend.
 */
export function ProductionReadinessNotice({ requestId, materialUsd = 0 }: { requestId: string; materialUsd?: number }) {
  const [check, setCheck] = useState<CheckView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    // F40: re-checked when the Director material ceiling changes, so the verdict covers what «Generar» will reserve.
    const q = materialUsd > 0 ? `?materialUsd=${encodeURIComponent(String(materialUsd))}` : "";
    const t = setTimeout(() => { if (alive) { setCheck(null); setFailed(false); } return fetch(`/api/generate/${requestId}/readiness${q}`, { cache: "no-store" })
      .then(async (res) => (await res.json()) as { check?: CheckView })
      .then((body) => { if (alive) { if (body.check) setCheck(body.check); else setFailed(true); } })
      .catch(() => { if (alive) setFailed(true); }); }, materialUsd > 0 ? 400 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [requestId, materialUsd]);

  if (failed) {
    return (
      <div className="my-3" data-testid="production-readiness">
        <Alert tone="warning">No pudimos comprobar ahora los recursos de esta producción. Al iniciar se vuelve a comprobar en el servidor; si no se confirma, no se gasta nada.</Alert>
      </div>
    );
  }
  if (!check) return <p className="my-3 text-sm text-ink-muted" role="status" data-testid="production-readiness">Comprobando plan y capacidad de producción…</p>;
  return (
    <div className="my-3" data-testid="production-readiness" data-outcome={check.outcome}>
      <ChecklistView check={check} />
    </div>
  );
}
