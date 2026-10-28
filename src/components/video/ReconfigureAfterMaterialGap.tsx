"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";

/**
 * Long Form detenido por falta de material ANTES de gastar: el mismo plan volvería a fallar, así que se ofrece
 * volver a Configurar (otra estrategia, imágenes IA para las escenas sin archivo). El servidor comprueba que no hubo
 * gasto de producción y hace la transición; el guion se conserva y no se cobra nada.
 */
export function ReconfigureAfterMaterialGap({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function handleClick() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/generate/${requestId}/reconfigure`, { method: "POST" });
      const result = await safeParseJsonResponse<{ configurePath: string }>(res);
      if (!result.ok) throw new Error(result.error);
      router.push(result.data.configurePath);
    } catch (err) {
      setError(classifyClientFetchError(err));
      setLoading(false);
      inFlight.current = false;
    }
  }

  return (
    <section aria-label="Volver a configurar" className="my-4 rounded-lg border border-border bg-surface p-4 text-sm">
      <p className="text-ink">
        Este plan se detuvo antes de gastar porque faltaba material de archivo. Repetirlo daría el mismo resultado: vuelve a
        configurar y elige una estrategia que cubra esas escenas. Tu guion se conserva y no se cobra nada.
      </p>
      <Button type="button" className="mt-3 w-full sm:w-auto" onClick={handleClick} loading={loading}>
        Volver a configurar la producción
      </Button>
      {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
    </section>
  );
}
