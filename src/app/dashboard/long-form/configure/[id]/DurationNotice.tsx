import { changeDurationHref, clock, type ChangeDurationFields } from "@/lib/video/long-form/change-duration";

/** Duración pedida y estimada A LA VISTA (no dentro de un desplegable) y una salida clara si no es la que se quería. */
export function DurationNotice({ requestedSeconds, estimatedSeconds, fields, topic }: { requestedSeconds: number | null; estimatedSeconds: number; fields: ChangeDurationFields | null; topic: string }) {
  const { href, sourcesDropped } = changeDurationHref(fields, topic);
  return (
    <section aria-label="Duración" data-testid="duration-notice" className="mt-4 rounded-lg border border-border p-4 text-sm">
      <p className="text-ink">
        {requestedSeconds !== null && <>Duración pedida: <strong>{Math.round(requestedSeconds / 60)} min</strong> · </>}
        Este guion dura <strong>~{clock(estimatedSeconds)}</strong>.
      </p>
      <p className="mt-2 text-ink-muted">
        ¿Querías otra duración? <a href={href} className="font-medium text-accent underline">Cambiar duración</a> prepara un guion nuevo con los mismos
        datos. Este guion queda guardado en Mis proyectos y aquí no se cobra nada; el guion nuevo tiene su propio costo de guion.
        {sourcesDropped && " Tus referencias son largas: vuelve a pegarlas en Opciones avanzadas."}
      </p>
    </section>
  );
}
