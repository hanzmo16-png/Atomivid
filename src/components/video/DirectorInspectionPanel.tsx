import { inspectionMotionSummary, inspectionMotionText, type ReelInspection } from "@/lib/video/director/reel-inspection";

const fmt = (s: number) => `${s.toFixed(1)} s`;

/**
 * Read-only panel (server-rendered) with the Director's proposal for a Reel. It has no buttons and no client
 * state: it cannot start, block or change a generation. Shown only when CINEMATIC_DIRECTOR_V2_ENABLED is on.
 */
export function DirectorInspectionPanel({ inspection }: { inspection: ReelInspection }) {
  const motion = inspection.status === "error" ? null : inspectionMotionSummary(inspection.shots);
  return (
    <details className="my-4 rounded-lg border border-border bg-surface p-4 text-sm" data-testid="director-inspection">
      <summary className="cursor-pointer font-semibold text-ink">
        Director (prueba): {inspection.status === "ok" ? "plan sin observaciones" : inspection.status === "issues" ? `${inspection.issues.length} observaciones` : "no disponible"}
      </summary>
      <p className="mt-2 text-ink-muted">Solo propuesta, antes de elegir el material · ejecutable: no · llamadas pagadas: {inspection.paidCalls}</p>
      {inspection.status === "error" ? (
        <p className="mt-2 text-ink-muted">No se pudo calcular la propuesta: {inspection.message}. Puedes generar con el flujo actual.</p>
      ) : (
        <>
          <p className="mt-2 text-ink-muted">{inspection.note}</p>
          {inspection.metrics && (
            <ul className="mt-2 grid grid-cols-2 gap-1 text-ink-muted">
              <li>Planos: {inspection.metrics.shots}</li>
              <li>Duración total: {fmt(inspection.totalSeconds)}</li>
              <li>Cobertura del guion: {inspection.metrics.coveragePct}%</li>
              <li>Clips con movimiento previstos (por confirmar con el material): {motion?.expectedClips}</li>
              <li>Zoom o paneo sobre imagen fija: {motion?.stillWithMove}</li>
              <li>Imagen fija: {motion?.still}</li>
              <li>Decisiones pendientes: {inspection.metrics.pendingDecisions}</li>
              <li>Licencias por revisar: {inspection.metrics.licensePending}</li>
              <li>Material nuevo (máx. estimado): USD {inspection.metrics.estimatedMaxUsd.toFixed(2)}</li>
              <li>Variedad de recetas: {inspection.metrics.recipeVariety}</li>
              <li>Misma receta seguida (máx.): {inspection.metrics.maxSameRecipeRun}</li>
            </ul>
          )}
          <ol className="mt-3 space-y-1">
            {inspection.shots.map(s => (
              <li key={s.id} className="text-ink">
                <span className="text-ink-muted">{fmt(s.start)}–{fmt(s.end)}</span> «{s.anchorText}» · {s.recipeId ?? "receta pendiente"} ·{" "}
                {inspectionMotionText(s)}
                {s.label ? ` · etiqueta ${s.label}` : ""}{s.decision === "pending" && s.pendingReason ? ` · pendiente: ${s.pendingReason}` : ""}
              </li>
            ))}
          </ol>
          {inspection.issues.length > 0 && (
            <ul className="mt-3 list-disc pl-5 text-ink-muted">
              {inspection.issues.slice(0, 30).map((i, n) => <li key={n}>{i.code}{i.shotId ? ` (${i.shotId})` : ""}: {i.detail}</li>)}
            </ul>
          )}
        </>
      )}
    </details>
  );
}
