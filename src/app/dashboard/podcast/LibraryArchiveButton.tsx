"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";
import type { LibraryKind } from "@/lib/podcast/library";

/**
 * Archivar / restaurar un episodio (biblioteca limpia). Archivar pide confirmación en el mismo lugar: se oculta de «Mis
 * episodios» y queda en «Archivados»; nada se borra (video, audio, enlaces y costos siguen igual).
 */
export function LibraryArchiveButton({ kind, id, title, archived }: { kind: LibraryKind; id: string; title: string; archived: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(action: "archive" | "restore") {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/podcast/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id, action }) });
      const out = await safeParseJsonResponse<{ ok?: boolean }>(res);
      if (!out.ok) { setError(out.error); return; }
      setConfirming(false);
      router.refresh();
    } catch (e) { setError(classifyClientFetchError(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="mt-2 text-xs" data-testid={`biblioteca-${archived ? "restaurar" : "archivar"}-${id}`}>
      {archived ? (
        <Button type="button" variant="secondary" size="sm" loading={busy} onClick={() => void send("restore")}>Restaurar</Button>
      ) : confirming ? (
        <div role="alertdialog" aria-label={`Archivar «${title}»`} className="grid gap-2 rounded border border-border p-2">
          <p className="text-ink">¿Archivar «{title}»? Deja de verse en «Mis episodios» y pasa a «Archivados». No se borra nada: puedes restaurarlo cuando quieras.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" loading={busy} onClick={() => void send("archive")}>Archivar</Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>Cancelar</Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>Archivar</Button>
      )}
      {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
