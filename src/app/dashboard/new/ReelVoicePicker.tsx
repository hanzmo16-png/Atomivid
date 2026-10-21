"use client";

import { useEffect, useRef, useState } from "react";
import type { ReelVoice, ReelVoiceCatalog } from "@/lib/video/reel-voices";
import { INPUT_CLASS } from "@/components/ui/Field";

/** Remembered per authenticated account and language in this browser (survives navigation, back/forward and reloads). Only an id, never audio. */
export const REEL_VOICE_STORAGE = (language: string, scope: string) => `atomivid.reelVoice.v2.${scope}.${language}`;
type Remembered = { voiceId: string; name: string };

const KIND_LABEL: Record<ReelVoice["kind"], string> = { private: "Tu voz clonada", library: "Biblioteca", stock: "Estándar" };
const categoryLabel = (v: ReelVoice) => v.kind === "private" ? (v.category === "professional" ? "Clon profesional · privada" : "Clon · privada") : KIND_LABEL[v.kind];

function readRemembered(language: string, scope: string): Remembered | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(REEL_VOICE_STORAGE(language, scope)) ?? "null") as Partial<Remembered> | null;
    return raw && typeof raw.voiceId === "string" && /^[A-Za-z0-9]{8,64}$/.test(raw.voiceId) ? { voiceId: raw.voiceId, name: String(raw.name ?? "") } : null;
  } catch { return null; }
}
function remember(language: string, scope: string, value: Remembered | null) {
  try {
    if (value) window.localStorage.setItem(REEL_VOICE_STORAGE(language, scope), JSON.stringify(value));
    else window.localStorage.removeItem(REEL_VOICE_STORAGE(language, scope));
  } catch { /* storage unavailable: the choice still lives in this form */ }
}

type Playback = "idle" | "loading" | "playing" | "error";

/** Mounted with key=language: changing language loads that language's catalogue and remembered choice. */
export function ReelVoicePicker({ language, onSelect }: { language: "es" | "en"; /** Long Form: recibe la voz confirmada ("" = predeterminada). */ onSelect?: (voiceId: string) => void }) {
  const [catalog, setCatalog] = useState<ReelVoiceCatalog | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState<Remembered | null>(null);
  const [pending, setPending] = useState(false);
  const [playback, setPlayback] = useState<Playback>("idle");
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let alive = true;
    void fetch(`/api/reel/voices?language=${language}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("catalog");
        const data: ReelVoiceCatalog = await response.json();
        if (!alive) return;
        setCatalog(data);
        const stored = data.storageScope ? readRemembered(language, data.storageScope) : null;
        if (stored && data.enabled) {
          if (data.voices.some(v => v.voiceId === stored.voiceId)) { setSelected(stored.voiceId); onSelect?.(stored.voiceId); }
          else { setUnavailable(stored); remember(language, data.storageScope!, null); }
        }
      }).catch(() => {
        if (!alive) return;
        setError("No pudimos cargar las voces. Puedes continuar con la voz predeterminada.");
        setPending(true);
      }).finally(() => clearTimeout(timer));
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [language]); // eslint-disable-line react-hooks/exhaustive-deps -- onSelect is a stable setter

  const voice = catalog?.voices.find(v => v.voiceId === selected);
  const preview = selected ? voice?.previewUrl ?? null : catalog?.defaultPreviewUrl ?? null;
  const shownName = selected ? voice?.name ?? "" : catalog?.defaultName ? `Voz predeterminada (${catalog.defaultName})` : "Voz predeterminada";
  if (catalog && !catalog.enabled) return null;

  const choose = (id: string) => {
    audio.current?.pause(); setPlayback("idle"); setUnavailable(null);
    setSelected(id);
    onSelect?.(catalog?.voices.some(x => x.voiceId === id) ? id : "");
    const v = catalog?.voices.find(x => x.voiceId === id);
    if (catalog?.storageScope) remember(language, catalog.storageScope, v ? { voiceId: v.voiceId, name: v.name } : null);
  };
  // One element, one existing provider URL: repeated clicks only toggle it, nothing is generated or charged.
  const toggle = async () => {
    const el = audio.current;
    if (!el || playback === "loading") return;
    if (playback === "playing") { el.pause(); setPlayback("idle"); return; }
    setPlayback("loading");
    try { await el.play(); setPlayback("playing"); } catch { setPlayback("error"); }
  };
  const privateVoices = catalog?.voices.filter(v => v.kind === "private") ?? [];
  const publicVoices = catalog?.voices.filter(v => v.kind !== "private") ?? [];

  return (
    <fieldset className="space-y-2" data-testid="reel-voice-picker">
      <legend className="text-sm font-medium text-ink">Voz de la narración</legend>
      <label className="sr-only" htmlFor="reel_voice_picker">Selecciona una voz</label>
      <select id="reel_voice_picker" className={INPUT_CLASS} value={selected} disabled={!catalog}
        onChange={event => choose(event.target.value)}>
        <option value="">{catalog?.defaultName ? `Voz predeterminada · ${catalog.defaultName}` : "Voz predeterminada"}</option>
        {privateVoices.length > 0 && <optgroup label="Tus voces clonadas (privadas)">
          {privateVoices.map(v => <option key={v.voiceId} value={v.voiceId}>{v.name}</option>)}
        </optgroup>}
        {publicVoices.length > 0 && <optgroup label="Voces disponibles">
          {publicVoices.map(v => <option key={v.voiceId} value={v.voiceId}>{v.name}{v.accent ? ` · ${v.accent}` : ""}</option>)}
        </optgroup>}
      </select>
      {/* Omitted for the default: preserves the legacy submission fingerprint exactly. Only a confirmed voice is sent. */}
      {selected && voice && <input type="hidden" name="reel_voice_id" value={selected} />}

      {catalog && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border-strong bg-surface-raised p-2 text-sm" aria-live="polite">
          <span className="font-medium text-ink" data-testid="reel-voice-selected">Seleccionada: {shownName}</span>
          <span className="rounded bg-accent-soft px-2 py-0.5 text-xs text-ink-muted">{voice ? categoryLabel(voice) : "Predeterminada"}</span>
          {preview ? (
            <button type="button" onClick={() => void toggle()} disabled={playback === "loading"} aria-pressed={playback === "playing"}
              aria-label={`${playback === "playing" ? "Pausar" : "Escuchar"} muestra: ${voice?.name ?? "voz predeterminada"}`}
              className="ml-auto min-h-11 rounded-md border border-border-strong px-3 text-sm">
              {playback === "loading" ? "Cargando…" : playback === "playing" ? "❚❚ Pausar" : "▶ Escuchar muestra"}
            </button>
          ) : (
            <span className="ml-auto text-xs text-ink-muted" role="note">Sin muestra gratuita del proveedor para esta voz.</span>
          )}
        </div>
      )}
      {preview && <audio ref={audio} key={preview} preload="none" src={preview}
        onEnded={() => setPlayback("idle")} onPause={() => setPlayback(p => p === "playing" ? "idle" : p)}
        onError={() => setPlayback("error")} />}
      {preview && <p className="text-xs text-ink-muted">Muestra existente del proveedor (sin costo); puede estar en otro idioma. Tu narración usará el idioma seleccionado.</p>}
      {playback === "error" && <p role="status" className="text-xs text-ink-muted">No se pudo reproducir la muestra. La voz seleccionada se conserva.</p>}
      {unavailable && <p role="alert" className="text-xs text-danger">La voz que elegiste antes{unavailable.name ? ` («${unavailable.name}»)` : ""} ya no está disponible. Elige otra voz; mientras tanto está marcada la predeterminada.</p>}
      {!catalog && !error && <p role="status" className="text-xs text-ink-muted">Cargando muestras de voz… Puedes continuar con la voz predeterminada.</p>}
      {error && <p role="status" className="text-xs text-ink-muted">{error}</p>}
      {pending && <p role="alert" className="text-xs text-danger">No pudimos confirmar tu voz guardada. Si continúas ahora se usará la voz predeterminada; recarga para reintentar.</p>}
    </fieldset>
  );
}
