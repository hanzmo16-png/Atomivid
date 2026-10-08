"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";
import type { AccountVoice } from "@/lib/podcast/voices";

const USD = new Intl.NumberFormat("es-MX", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function NewEpisode({ voices, voicesError, usdPer1kChars, maxChars }: { voices: AccountVoice[]; voicesError: string | null; usdPer1kChars: number; maxChars: number }) {
  const router = useRouter();
  const [mode, setMode] = useState<"tts" | "upload">("tts");
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [voiceId, setVoiceId] = useState(voices[0]?.voiceId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chars = script.trim().length;
  const voice = voices.find((v) => v.voiceId === voiceId);

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/podcast", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "upload" ? { source: "upload", title, language } : { title, script, language, voiceId }) });
      const out = await safeParseJsonResponse<{ id: string }>(res);
      if (!out.ok) throw new Error(out.error);
      router.push(`/dashboard/podcast/${out.data.id}`);
    } catch (e) {
      setError(classifyClientFetchError(e));
      setBusy(false);
    }
  }

  const input = "w-full rounded border border-border-strong bg-surface-raised px-2 py-1 text-sm";
  return (
    <Card className="mt-4 p-4">
      <div className="flex gap-4 text-sm" role="radiogroup" aria-label="Origen del audio">
        <label><input type="radio" checked={mode === "tts"} onChange={() => setMode("tts")} /> Voz sintética de mi cuenta</label>
        <label><input type="radio" checked={mode === "upload"} onChange={() => setMode("upload")} /> Mi propia grabación</label>
      </div>
      <label className="mt-3 block text-sm">Título<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={input} /></label>
      <label className="mt-3 block text-sm">Idioma
        <select value={language} onChange={(e) => setLanguage(e.target.value === "en" ? "en" : "es")} className={input}><option value="es">Español</option><option value="en">Inglés</option></select>
      </label>
      {mode === "tts" && (
        <>
          <label className="mt-3 block text-sm">Guion
            <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={10} maxLength={maxChars} className={input} placeholder="Escribe o pega el guion del episodio" />
          </label>
          <p className="mt-1 text-xs text-ink-muted">{chars.toLocaleString("es-MX")} / {maxChars.toLocaleString("es-MX")} caracteres · costo estimado {USD.format((chars / 1000) * usdPer1kChars)} · ≈ {Math.max(1, Math.round(chars / 15 / 60))} min de audio. El costo exacto y la capacidad se muestran antes de generar.</p>
          {voicesError ? <p role="alert" className="mt-3 text-sm text-danger">{voicesError}</p> : (
            <label className="mt-3 block text-sm">Voz (disponibles en tu cuenta de ElevenLabs)
              <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} className={input}>
                {voices.map((v) => <option key={v.voiceId} value={v.voiceId}>{v.name}{[v.language, v.accent, v.gender].filter(Boolean).length ? ` — ${[v.language, v.accent, v.gender].filter(Boolean).join(", ")}` : ""}</option>)}
              </select>
            </label>
          )}
          {voice?.previewUrl && <audio controls preload="none" src={voice.previewUrl} className="mt-2 w-full" aria-label={`Muestra de la voz ${voice.name}`} />}
          {voice && !voice.previewUrl && <p className="mt-1 text-xs text-ink-muted">Esta voz no tiene muestra pública.</p>}
        </>
      )}
      {mode === "upload" && <p className="mt-3 text-xs text-ink-muted">Después de crear el episodio podrás subir el archivo (MP3, M4A, WAV, WebM u Ogg; hasta 150 MB). Se normaliza el volumen; no se clona ninguna voz.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <Button type="button" onClick={create} loading={busy} disabled={!title.trim() || (mode === "tts" && (chars < 20 || !voiceId || !!voicesError))} className="mt-4">
        Crear episodio (no genera ni cobra)
      </Button>
    </Card>
  );
}
