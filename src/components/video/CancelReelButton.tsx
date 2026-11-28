"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";

/**
 * «Cancelar producción» for a queued/rendering Reel. Two steps (ask, then confirm) so a stray tap never cancels.
 * The server (POST /api/generate/[id]/cancel) re-checks owner, mode, state and stage; it never charges anything.
 */
export function CancelReelButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function cancel() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await safeParseJsonResponse(await fetch(`/api/generate/${requestId}/cancel`, { method: "POST" }));
      if (!result.ok) throw new Error(result.error);
    } catch (err) {
      setError(classifyClientFetchError(err));
    } finally {
      setLoading(false);
      setConfirming(false);
      inFlight.current = false;
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col items-center gap-1.5" data-testid="cancel-reel">
      {confirming ? (
        <>
          <p className="text-xs text-ink-muted">¿Cancelar? No se envía ningún cobro nuevo; podrás reintentar después.</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="danger" className="min-h-11" onClick={cancel} loading={loading}>Sí, cancelar</Button>
            <Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={() => setConfirming(false)} disabled={loading}>Seguir produciendo</Button>
          </div>
        </>
      ) : (
        <Button type="button" size="sm" variant="secondary" className="min-h-11" onClick={() => setConfirming(true)}>Cancelar producción</Button>
      )}
      {error && <p className="max-w-[260px] text-center text-xs text-danger">{error}</p>}
    </div>
  );
}
