"use client";

import { useEffect, useRef, useState } from "react";
import type { ReelVoiceCatalog } from "@/lib/video/reel-voices";
import { INPUT_CLASS } from "@/components/ui/Field";

/** Mounted with key=language: changing language clears the selection and stops its preview. */
export function ReelVoicePicker({ language }: { language: "es" | "en" }) {
  const [catalog, setCatalog] = useState<ReelVoiceCatalog | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let alive = true;
    void fetch(`/api/reel/voices?language=${language}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("catalog");
        const data: ReelVoiceCatalog = await response.json();
        if (alive) setCatalog(data);
      }).catch(() => {
        if (alive) setError("No pudimos cargar las voces. Puedes continuar con la voz predeterminada.");
      }).finally(() => clearTimeout(timer));
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [language]);
  const voice = catalog?.voices.find(v => v.voiceId === selected);
  const preview = selected ? voice?.previewUrl : catalog?.defaultPreviewUrl;
  if (catalog && !catalog.enabled) return null;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-ink">Voz de la narración</legend>
      <label className="sr-only" htmlFor="reel_voice_picker">Selecciona una voz</label>
      <select id="reel_voice_picker" className={INPUT_CLASS} value={selected} disabled={!catalog}
        onChange={event => { audio.current?.pause(); setSelected(event.target.value); setPreviewFailed(false); }}>
        <option value="">Voz predeterminada</option>
        {catalog?.voices.map(v => <option key={v.voiceId} value={v.voiceId}>{v.name}{v.accent ? ` · ${v.accent}` : ""}</option>)}
      </select>
      {/* Omitted for the default: preserves the legacy submission fingerprint exactly. */}
      {selected && <input type="hidden" name="reel_voice_id" value={selected} />}
      {preview && <audio ref={audio} key={preview} controls preload="none" src={preview}
        aria-label={`Escuchar muestra: ${voice?.name ?? "voz predeterminada"}`} className="w-full" onError={() => setPreviewFailed(true)} />}
      {preview && <p className="text-xs text-ink-muted">Muestra del proveedor; puede estar en otro idioma. Tu narración usará el idioma seleccionado.</p>}
      {previewFailed && <p role="status" className="text-xs text-ink-muted">No se pudo reproducir la muestra. La voz seleccionada se conserva.</p>}
      {!catalog && !error && <p role="status" className="text-xs text-ink-muted">Cargando muestras de voz… Puedes continuar con la voz predeterminada.</p>}
      {error && <p role="status" className="text-xs text-ink-muted">{error}</p>}
    </fieldset>
  );
}
