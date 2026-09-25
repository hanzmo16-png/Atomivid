"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSubscription, setNeedsSubscription] = useState(false);

  async function handleClick() {
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
      <Button type="button" size="sm" onClick={handleClick} loading={loading}>
        {loading ? "Generando…" : label}
      </Button>
      {error && <p className="max-w-[220px] text-right text-xs text-danger">{error}</p>}
      {needsSubscription && (
        <Link href="/dashboard/billing" className="text-right text-xs font-medium text-accent hover:text-accent-hover">
          Ver planes
        </Link>
      )}
    </div>
  );
}
