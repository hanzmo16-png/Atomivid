import { generationActive, type Generation } from "@/lib/audio-studio/model";

/** Percentages describe completed voice segments, never simulated elapsed time. */
export function AudioGenerationProgress({ generation: g, now, submitting = false, connectionError = false, uncertain = false }: {
  generation: Generation; now: number; submitting?: boolean; connectionError?: boolean; uncertain?: boolean;
}) {
  if (!submitting && !uncertain && g.status === "inactiva") return null;
  const active = generationActive(g, now);
  const total = g.progress?.total ?? 0;
  const done = Math.max(0, Math.min(total, g.progress?.done ?? 0));
  const percent = total > 0 ? Math.floor(done / total * 100) : 0;
  const mixing = g.status === "generando" && total > 0 && done === total;
  const interrupted = !active && (g.status === "en_cola" || g.status === "generando");
  const unknown = connectionError || uncertain;
  const title = unknown ? "Comprobando el estado del podcast…"
    : submitting ? "Enviando solicitud de generación…"
    : g.status === "terminada" ? "Podcast listo · 100%"
    : g.status === "fallida" ? "No se pudo completar el podcast"
    : interrupted ? "La generación dejó de informar avances"
    : g.status === "en_cola" ? "Solicitud recibida · esperando para comenzar"
    : mixing ? "Voces completas · mezclando y preparando el MP3…"
    : total > 0 ? `Generando voces · ${percent}%` : "Preparando la generación de voces…";
  const indeterminate = unknown || submitting || mixing || (active && total === 0);
  return (
    <div data-testid="audio-progress" className="space-y-2 rounded-md border border-accent-border bg-surface-raised p-4" role="status" aria-live="polite" aria-atomic="true">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <div className="h-2 w-full overflow-hidden rounded bg-surface" role="progressbar" aria-label="Avance de la generación del podcast"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : g.status === "terminada" ? 100 : percent} aria-valuetext={title}>
        <div className={`h-2 rounded bg-accent ${indeterminate ? "animate-pulse motion-reduce:animate-none" : "transition-all"}`} style={{ width: indeterminate ? "35%" : `${g.status === "terminada" ? 100 : percent}%` }} />
      </div>
      <p className="text-xs text-ink-muted">
        {unknown ? "No podemos confirmar el avance en este momento. Estamos consultándolo de nuevo; no vuelvas a generar el episodio."
          : submitting ? "Espera mientras confirmamos la solicitud. El botón queda bloqueado para evitar duplicados."
          : g.status === "terminada" ? "Ya puedes escuchar y descargar tu MP3."
          : g.status === "fallida" ? "Revisa el motivo indicado abajo antes de reanudar."
          : interrupted ? "No hay actualizaciones recientes del servidor. Revisa el estado antes de reanudar."
          : g.status === "en_cola" ? "El servidor recibió tu solicitud. El porcentaje aparecerá al comenzar las voces."
          : total > 0 ? `${done} de ${total} fragmentos de voz completados. ${mixing ? "El audio estará listo cuando termine la mezcla y se guarde el archivo." : "Después se mezclará la música y se guardará el MP3."}`
          : "El porcentaje aparecerá cuando el servidor informe los fragmentos completados."}
      </p>
    </div>
  );
}
