"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { startYouTubeConnect } from "./connect-youtube";

/**
 * Owner-only control rendered by the (already owner-gated) Command Center page. It never sees
 * scopes, secrets or tokens: one POST to the server, then follow Google's consent URL.
 */
export function ConnectYouTubeButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onClick = async () => {
    setPending(true); setError(null);
    const r = await startYouTubeConnect({ fetchImpl: (url, init) => fetch(url, init), navigate: (url) => window.location.assign(url) });
    if (!r.ok) { setError(r.message); setPending(false); }
  };
  return (
    <div className="mt-3 flex min-w-0 flex-col gap-2" data-youtube-connect>
      <Button type="button" onClick={onClick} loading={pending} className="w-full sm:w-auto" data-testid="connect-youtube-readonly">Conectar YouTube (solo lectura)</Button>
      <p className="text-[11px] leading-snug text-ink-faint">Conexión de solo lectura para métricas y analytics. No permite subir, editar ni publicar videos.</p>
      {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
    </div>
  );
}
