import { inspectionMotionSummary, inspectionMotionText, simulatedIssueText, SIMULATION_NOTICE, type ReelInspection } from "@/lib/video/director/reel-inspection";

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
      {/* chatgpt-30 C1: before the render the page can only say "eligible" (requested at generation); "applied" is the video page's word. */}
      {inspection.status !== "error" && (
        <p className="mt-1 text-ink-muted" data-testid="director-render-request">
          Estado antes del render: {inspection.renderRequest === "eligible" ? "elegible · se solicitará al generar · se confirma solo con el video terminado" : "solo propuesta · el render no usa el Director"}
        </p>
      )}
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
              <li>Material nuevo que pediría el plan (simulación, máx.): USD {inspection.metrics.estimatedMaxUsd.toFixed(2)}</li>
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
            <>
              <p className="mt-3 text-xs text-ink-faint" data-testid="director-simulation-notice">{SIMULATION_NOTICE}</p>
              <ul className="mt-1 list-disc pl-5 text-ink-muted">
                {inspection.issues.slice(0, 30).map((i, n) => <li key={n}>{simulatedIssueText(i)}</li>)}
              </ul>
            </>
          )}
        </>
      )}
    </details>
  );
}
