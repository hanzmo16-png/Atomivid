"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { createUploadTicketAction, finalizeUploadAction } from "./actions";

const MAX_MB = 25;

/** Subir un archivo para UN contrato: queda como propuesta; aprobarla es otra decisión del curador. */
export function UploadAsset({ requestId, contractKey, inputClass }: { requestId: string; contractKey: string; inputClass: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) return setMessage({ ok: false, text: "Elige un archivo." });
    if (file.size > MAX_MB * 1024 * 1024) return setMessage({ ok: false, text: `El archivo supera ${MAX_MB} MB.` });
    data.delete("file");
    setBusy(true);
    setMessage(null);
    try {
      const ticket = await createUploadTicketAction(requestId, contractKey, file.type, file.size);
      if ("error" in ticket) throw new Error(ticket.error);
      const { error } = await createClient().storage.from("videos").uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: file.type });
      if (error) throw new Error("La subida no se completó. Revisa tu conexión e inténtalo de nuevo.");
      const done = await finalizeUploadAction(requestId, contractKey, ticket.path, data);
      if ("error" in done) throw new Error(done.error);
      form.reset();
      setMessage({ ok: true, text: "Archivo validado y propuesto para este contrato. Revísalo arriba y apruébalo o recházalo." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "No se pudo subir el archivo." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 grid grid-cols-2 gap-2">
      <p className="col-span-2 text-xs text-ink-muted">Subir archivo (JPEG, PNG o WebP; lado largo ≥ 1280 px; máx. {MAX_MB} MB). El servidor comprueba el tipo real, las dimensiones y la huella SHA-256.</p>
      <input name="file" type="file" accept="image/jpeg,image/png,image/webp" required className={`col-span-2 ${inputClass}`} />
      <select name="rightsKind" defaultValue="PD" className={inputClass} aria-label="Derechos">
        <option value="PD">Dominio público</option>
        <option value="CC0">CC0</option>
        <option value="CC_BY">CC BY (exige crédito)</option>
        <option value="LICENSED">Licenciado (contrato)</option>
        <option value="OWNED">Material propio</option>
      </select>
      <input name="sourceUrl" placeholder="Página de procedencia (https://…)" className={inputClass} />
      <input name="licenseUrl" placeholder="URL de la licencia o declaración de derechos" className={inputClass} />
      <input name="rightsReference" placeholder="Referencia de contrato/autoría (licenciado o propio)" className={inputClass} />
      <input name="creator" placeholder="Autor" className={inputClass} />
      <input name="creditText" placeholder="Crédito visible" className={inputClass} />
      <input name="description" placeholder="Qué muestra exactamente" className={`col-span-2 ${inputClass}`} />
      <button type="submit" disabled={busy} className="col-span-2 rounded border border-border-strong px-3 py-1 disabled:opacity-50">
        {busy ? "Subiendo y validando…" : "Subir y proponer para este contrato"}
      </button>
      {message && <p role={message.ok ? "status" : "alert"} className={`col-span-2 text-sm ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</p>}
    </form>
  );
}
