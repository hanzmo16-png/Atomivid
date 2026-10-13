import type { AppliedShotRow } from "@/lib/video/director-applied";

const MOTION: Record<string, string> = { real: "clip real (sin zoom añadido)", static: "fijo", push_in: "zoom lento declarado sobre foto", pan: "paneo declarado sobre foto", hook: "zoom de gancho" };
const TRANS: Record<string, string> = { cut: "corte", crossfade: "fundido cruzado", fade: "fundido a/desde negro" };
const LABEL: Record<string, string> = { recreacion_ia: "Recreación IA", ilustrativa: "Imagen ilustrativa" };
const s = (x: number) => `${x.toFixed(1)} s`;

/** Read-only: which recipe the Director applied to each shot of this video (shown only with the render flag on). */
export function DirectorAppliedPanel({ rows }: { rows: AppliedShotRow[] }) {
  return (
    <details className="my-4 rounded-lg border border-border bg-surface p-4 text-sm" data-testid="director-applied" open>
      <summary className="cursor-pointer font-semibold text-ink">Director: recetas aplicadas ({rows.length} planos)</summary>
      <p className="mt-2 text-ink-muted">Montaje dirigido por recetas sobre el material ya existente. Prueba técnica: no acredita calidad visual.</p>
      <ol className="mt-3 space-y-2">
        {rows.map((r, i) => (
          <li key={r.shotId} className="text-ink" data-testid="director-applied-shot">
            <span className="text-ink-muted">{i + 1}. {s(r.startSeconds)}–{s(r.endSeconds)}</span> «{r.anchorText}»
            <br />
            <span className="text-ink-muted">
              Receta: <strong className="text-ink">{r.recipeId ?? "sin receta"}</strong> · movimiento: {MOTION[r.motion] ?? r.motion} · entrada: {TRANS[r.transitionIn] ?? r.transitionIn} · salida: {TRANS[r.transitionOut] ?? r.transitionOut}
              {r.label ? ` · etiqueta visible: ${LABEL[r.label] ?? r.label}` : ""}
              {r.unsupported.length ? ` · no soportado: ${r.unsupported.join("; ")}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
