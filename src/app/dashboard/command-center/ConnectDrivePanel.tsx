"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { driveResultMessage, startDriveConnect } from "./connect-drive";

/**
 * Owner-only panel (the Command Center page is already owner-gated). Shows whether the orchestrator's Drive channel is
 * connected and since when; never a token. One POST to the server, then Google's consent page.
 */
export function ConnectDrivePanel({ configured, connected, connectedAt, result }: { configured: boolean; connected: boolean; connectedAt: string | null; result?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notice = driveResultMessage(result);
  const onClick = async () => {
    setPending(true); setError(null);
    const r = await startDriveConnect({ fetchImpl: (url, init) => fetch(url, init), navigate: (url) => window.location.assign(url) });
    if (!r.ok) { setError(r.message); setPending(false); }
  };
  return (
    <section className="rounded-xl border border-border bg-surface p-4" data-drive-connect={connected ? "CONNECTED" : configured ? "NOT_CONNECTED" : "NOT_CONFIGURED"}>
      <p className="text-sm font-semibold text-ink">Canal de coordinación (Google Drive)</p>
      <p className="mt-1 text-xs text-ink-muted">{connected ? `Conectado${connectedAt ? ` desde ${connectedAt.slice(0, 16).replace("T", " ")} UTC` : ""}.` : configured ? "Sin conectar." : "Falta configurar el cliente OAuth web en el servidor."}</p>
      {notice && <p role={notice.tone === "error" ? "alert" : "status"} className={`mt-2 break-words text-xs ${notice.tone === "error" ? "text-danger" : "text-ink"}`}>{notice.text}</p>}
      {configured && (
        <div className="mt-3 flex min-w-0 flex-col gap-2">
          <Button type="button" onClick={onClick} loading={pending} className="w-full sm:w-auto" data-testid="connect-google-drive">{connected ? "Volver a conectar Google Drive" : "Conectar Google Drive"}</Button>
          <p className="text-[11px] leading-snug text-ink-faint">Usa la cuenta dueña de la carpeta «Atomivid-Coordinacion-Codex-Grok». El permiso se guarda cifrado en el servidor; GitHub Actions solo recibe accesos que caducan en una hora.</p>
        </div>
      )}
      {error && <p role="alert" className="mt-2 break-words text-xs text-danger">{error}</p>}
    </section>
  );
}
