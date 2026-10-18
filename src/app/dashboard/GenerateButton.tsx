"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";
import { parseStartOutcome } from "@/lib/video/start-outcome";
import { useReportStartOutcome } from "@/components/video/StartErrorNotice";

export function GenerateButton({
  endpoint,
  label,
  redirectTo,
}: {
  endpoint: string;
  label: string;
  /** Si se da, navega ahí al terminar en vez de solo refrescar la página. */
  redirectTo?: string;
}) {
  const router = useRouter();
  const reportStart = useReportStartOutcome();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSubscription, setNeedsSubscription] = useState(false);
  // The server's typed outcome said only support can fix the cause: the same action is not offered again.
  const [supportHold, setSupportHold] = useState(false);
  // Synchronous guard: a second click before React re-renders the disabled button sends nothing.
  // (The server's conditional UPDATE remains the real protection against two tabs.)
  const inFlight = useRef(false);

  async function handleClick() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    setNeedsSubscription(false);

    try {
      const res = await fetch(endpoint, { method: "POST" });
      const result = await safeParseJsonResponse(res);

      if (!result.ok) {
        if (result.status === 402) {
          setNeedsSubscription(true);
        }
        const outcome = parseStartOutcome((result.body as { outcome?: unknown } | undefined)?.outcome);
        // Inside the video page the outcome goes to the page, so the notice and every start/retry action
        // (with its "press «…»" text) follow it together; elsewhere this button just stops offering itself.
        if (outcome?.retry === "support" && !reportStart?.(result.error, outcome)) setSupportHold(true);
        throw new Error(result.error);
      }

      if (redirectTo) {
        router.push(redirectTo);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(classifyClientFetchError(err));
      setLoading(false);
      inFlight.current = false;
      // Refresca en cualquier caso: si la petición sí llegó al servidor,
      // este ya marcó la solicitud como fallida (rutas /api/generate/[id]/
      // script y /render) y sin este refresh la insignia de estado se
      // quedaba en su valor anterior, contradiciendo el mensaje de error
      // de abajo. Si nunca llegó (fallo de red — el caso que distingue
      // classifyClientFetchError), la fila no cambió y este refresh solo
      // vuelve a mostrar el mismo estado de siempre: inofensivo en ambos
      // casos, nunca se crea ni se toca una segunda solicitud desde aquí.
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {!supportHold && (
        <Button type="button" size="sm" onClick={handleClick} loading={loading}>
          {loading ? "Generando…" : label}
        </Button>
      )}
      {loading && (
        <div className="w-full min-w-[180px] max-w-[260px]" role="status" aria-live="polite">
          <p className="mb-1.5 text-xs font-medium text-ink-muted">
            {endpoint.endsWith("/script") ? "Generando guion…" : endpoint.endsWith("/render") ? "Iniciando producción…" : "Procesando solicitud…"}
          </p>
          <div
            role="progressbar"
            aria-label="Actividad de generación"
            aria-valuetext="Operación en curso, porcentaje no disponible"
            className="h-2 w-full overflow-hidden rounded-full bg-surface-raised"
          >
            <div className="h-full w-2/5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
          </div>
        </div>
      )}
      {error && <p className="max-w-[220px] text-right text-xs text-danger">{error}</p>}
      {needsSubscription && (
        <Link href="/dashboard/billing" className="text-right text-xs font-medium text-accent hover:text-accent-hover">
          Ver planes
        </Link>
      )}
    </div>
  );
}
