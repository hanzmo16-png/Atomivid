"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { createClient } from "@/lib/supabase/client";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";

export type TurnRow = { id: string; speaker: "A" | "B"; name: string; text: string; source: "voice" | "own_recording"; state: "nuevo" | "reutilizado" | "pendiente" | "grabación" };

/**
 * Podcast 2.1, por turno: subir la grabación propia de un turno (sin TTS) o editar el texto de UN turno.
 * Tras un cambio el episodio vuelve a borrador; al regenerar solo se sintetiza lo cambiado (el resto se reutiliza a USD 0).
 * Con una operación incierta todo queda bloqueado: reintentar podría cobrar dos veces.
 */
export function TurnsPanel(props: { episodeId: string; turns: TurnRow[]; locked: string | null; uncertain: number }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const blocked = props.uncertain > 0 ? "Bloqueado: hay una operación con el proveedor de resultado incierto." : props.locked;

  async function call(body: Record<string, unknown>) {
    const res = await fetch(`/api/podcast/${props.episodeId}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await safeParseJsonResponse<{ path?: string; token?: string }>(res);
    if (!out.ok) throw new Error(out.error);
    return out.data;
  }
  async function save(turnId: string) {
    if (busy) return;
    setBusy(turnId); setMessage(null);
    try { await call({ action: "edit", turnId, text: draft }); setEditing(null); setMessage({ ok: true, text: `Turno ${turnId} actualizado. Al regenerar solo se volverá a sintetizar este turno.` }); }
    catch (e) { setMessage({ ok: false, text: e instanceof Error && e.message ? e.message : classifyClientFetchError(e) }); }
    finally { setBusy(null); router.refresh(); }
  }
  async function upload(turnId: string, file: File | undefined) {
    if (busy || !file) return;
    setBusy(turnId); setMessage(null);
    try {
      const t = await call({ action: "ticket", mime: file.type, size: file.size });
      const { error } = await createClient().storage.from("videos").uploadToSignedUrl(String(t.path), String(t.token), file, { contentType: file.type });
      if (error) throw new Error("La subida no se completó. Revisa tu conexión e inténtalo de nuevo.");
      await call({ action: "attach", turnId, path: t.path });
      setMessage({ ok: true, text: `Grabación asignada al turno ${turnId}: se usará tal cual, sin voz sintética ni cobro.` });
    } catch (e) { setMessage({ ok: false, text: e instanceof Error && e.message ? e.message : classifyClientFetchError(e) }); }
    finally { setBusy(null); router.refresh(); }
  }

  return (
    <Card className="mt-4 p-4 text-sm">
      <h2 className="text-base font-semibold text-ink">Turnos</h2>
      <p className="mt-1 text-ink-muted">Puedes subir tu propia grabación para un turno o corregir el texto de un solo turno. Al regenerar, solo se sintetiza lo que cambió; los demás segmentos se reutilizan sin costo.</p>
      {props.uncertain > 0 && (
        <div role="alert" className="mt-3 rounded-md border border-danger px-3 py-2 text-danger">
          <p className="font-medium">Requiere revisión: {props.uncertain} operación(es) con resultado incierto.</p>
          <p className="mt-1">Una llamada al proveedor de voz pudo cobrarse sin devolver el audio. Reintentar o editar ahora podría cobrar dos veces, por eso está bloqueado. Hay que conciliarla con el historial de ElevenLabs antes de continuar.</p>
        </div>
      )}
      {blocked && props.uncertain === 0 && <p role="status" className="mt-3 text-warning">{blocked}</p>}
      {message && <p role={message.ok ? "status" : "alert"} className={`mt-3 ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</p>}
      <ol className="mt-3 space-y-2">
        {props.turns.map((t) => (
          <li key={t.id} data-turn={t.id} className="rounded-md border border-border px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-ink">{t.id} · {t.name}</span>
              <span data-turn-state className="text-xs text-ink-muted">{t.source === "own_recording" ? "Grabación propia (sin TTS)" : t.state === "reutilizado" ? "Voz: reutilizado" : t.state === "nuevo" ? "Voz: sintetizado" : "Voz: pendiente"}</span>
            </div>
            {editing === t.id ? (
              <div className="mt-2 space-y-2">
                <textarea aria-label={`Texto del turno ${t.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className="w-full rounded-md border border-border bg-surface px-3 py-2" />
                <div className="flex gap-2">
                  <Button type="button" onClick={() => save(t.id)} loading={busy === t.id} disabled={!!blocked || !draft.trim()}>Guardar turno {t.id}</Button>
                  <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancelar</Button>
                </div>
              </div>
            ) : (
              <p className="mt-1 whitespace-pre-wrap break-words text-ink">{t.text}</p>
            )}
            {editing !== t.id && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" disabled={!!blocked || !!busy} onClick={() => { setEditing(t.id); setDraft(t.text); }}>Editar turno {t.id}</Button>
                <label className={`inline-flex items-center gap-2 ${blocked || busy ? "opacity-50" : "cursor-pointer"}`}>
                  <span className="underline">Subir grabación para {t.id}</span>
                  <input type="file" accept="audio/*" aria-label={`Grabación del turno ${t.id}`} disabled={!!blocked || !!busy} className="sr-only" onChange={(e) => upload(t.id, e.target.files?.[0])} />
                </label>
              </div>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
