"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";
import type { AccountVoice } from "@/lib/podcast/voices";
import { parseDialogue } from "@/lib/podcast/v2/dialogue";

const USD = new Intl.NumberFormat("es-MX", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function NewEpisode({ voices, voicesError, usdPer1kChars, maxChars, v2Enabled = false }: { voices: AccountVoice[]; voicesError: string | null; usdPer1kChars: number; maxChars: number; v2Enabled?: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"tts" | "upload">("tts");
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [voiceId, setVoiceId] = useState(voices[0]?.voiceId ?? "");
  const [format, setFormat] = useState<"single" | "conversation">("single");
  const [style, setStyle] = useState<"standard" | "emotional">("standard");
  const [music, setMusic] = useState(false);
  const [nameA, setNameA] = useState("");
  const [nameB, setNameB] = useState("");
  const [roleB, setRoleB] = useState("");
  const [voiceB, setVoiceB] = useState(voices.find((v) => v.voiceId !== voices[0]?.voiceId)?.voiceId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chars = script.trim().length;
  const voice = voices.find((v) => v.voiceId === voiceId);
  const conversation = v2Enabled && format === "conversation";
  let turns: { speaker: "A" | "B"; text: string }[] = [], turnsError: string | null = null;
  if (conversation && script.trim()) { try { turns = parseDialogue(script, "conversation"); } catch (e) { turnsError = (e as Error).message; } }
  const convInvalid = conversation && (!voiceB || voiceB === voiceId || !!turnsError || !turns.some((t) => t.speaker === "A") || !turns.some((t) => t.speaker === "B"));
  const production = v2Enabled && (conversation || style === "emotional" || music)
    ? { mode: format, style, music, dialogue: script, participants: [{ id: "A", name: nameA || "A", voiceId }, ...(conversation ? [{ id: "B", name: nameB || "B", role: roleB, voiceId: voiceB }] : [])] }
    : null;

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/podcast", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "upload" ? { source: "upload", title, language } : { title, script, language, voiceId, production }) });
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
          {v2Enabled && (
            <fieldset className="mt-3 text-sm" data-testid="podcast-v2-options">
              <div className="flex gap-4" role="radiogroup" aria-label="Formato">
                <label><input type="radio" name="format" checked={format === "single"} onChange={() => setFormat("single")} /> Narración individual</label>
                <label><input type="radio" name="format" checked={format === "conversation"} onChange={() => setFormat("conversation")} /> Conversación (2 participantes)</label>
              </div>
              <div className="mt-2 flex gap-4" role="radiogroup" aria-label="Estilo de narración">
                <label><input type="radio" name="style" checked={style === "standard"} onChange={() => setStyle("standard")} /> Estándar</label>
                <label><input type="radio" name="style" checked={style === "emotional"} onChange={() => setStyle("emotional")} /> Emocional (director de voz)</label>
              </div>
              <label className="mt-2 block"><input type="checkbox" checked={music} onChange={(e) => setMusic(e.target.checked)} /> Música de fondo con licencia (se atenúa bajo la voz)</label>
              {conversation && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label>Nombre del participante A<input aria-label="Nombre A" value={nameA} onChange={(e) => setNameA(e.target.value)} maxLength={60} className={input} /></label>
                  <label>Nombre del participante B<input aria-label="Nombre B" value={nameB} onChange={(e) => setNameB(e.target.value)} maxLength={60} className={input} /></label>
                  <label className="sm:col-span-2">Rol o personalidad de B<input aria-label="Rol B" value={roleB} onChange={(e) => setRoleB(e.target.value)} maxLength={120} className={input} /></label>
                  <label className="sm:col-span-2">Voz del participante B (distinta de A)
                    <select aria-label="Voz B" value={voiceB} onChange={(e) => setVoiceB(e.target.value)} className={input}>
                      {voices.filter((v) => v.voiceId !== voiceId).map((v) => <option key={v.voiceId} value={v.voiceId}>{v.name}</option>)}
                    </select>
                  </label>
                  <p className="sm:col-span-2 text-xs text-ink-muted">Imagen distinta por participante y subtítulos con su nombre. Sin avatares en conversación. Es una conversación guionizada: no se presenta como entrevista real.</p>
                </div>
              )}
            </fieldset>
          )}
          <label className="mt-3 block text-sm">{conversation ? "Guion de la conversación (cada turno empieza con «A:» o «B:»)" : "Guion"}
            <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={10} maxLength={maxChars} className={input} placeholder="Escribe o pega el guion del episodio" />
          </label>
          <p className="mt-1 text-xs text-ink-muted">{chars.toLocaleString("es-MX")} / {maxChars.toLocaleString("es-MX")} caracteres · costo estimado {USD.format((chars / 1000) * usdPer1kChars)} · ≈ {Math.max(1, Math.round(chars / 15 / 60))} min de audio. El costo exacto y la capacidad se muestran antes de generar.</p>
          {conversation && turns.length > 0 && (
            <ol aria-label="Vista previa de turnos" className="mt-2 max-h-48 overflow-auto text-xs">
              {turns.map((t, i) => <li key={i} data-speaker={t.speaker}><strong>T{String(i + 1).padStart(3, "0")} · {t.speaker === "A" ? nameA || "A" : nameB || "B"}:</strong> {t.text}</li>)}
            </ol>
          )}
          {turnsError && <p role="alert" className="mt-1 text-xs text-danger">{turnsError}</p>}
          {voicesError ? <p role="alert" className="mt-3 text-sm text-danger">{voicesError}</p> : (
            <label className="mt-3 block text-sm">{conversation ? "Voz del participante A" : "Voz (disponibles en tu cuenta de ElevenLabs)"}
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
      <Button type="button" onClick={create} loading={busy} disabled={!title.trim() || (mode === "tts" && (chars < 20 || !voiceId || !!voicesError || convInvalid))} className="mt-4">
        Crear episodio (no genera ni cobra)
      </Button>
    </Card>
  );
}
