"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";
import type { AccountVoice } from "@/lib/podcast/voices";
import { DRAFT_KEY, parseDraft, type EpisodeDraft } from "@/lib/podcast/production-contract";

const USD = new Intl.NumberFormat("es-MX", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

const readDraft = (maxChars: number) => { try { return parseDraft(window.sessionStorage.getItem(DRAFT_KEY), maxChars); } catch { return null; } };
const writeDraft = (d: EpisodeDraft | null) => { try { if (d) window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); else window.sessionStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable: the form still works */ } };

export function NewEpisode({ voices, voicesError, usdPer1kChars, maxChars, initialDraft, initialStep }: {
  voices: AccountVoice[]; voicesError: string | null; usdPer1kChars: number; maxChars: number;
  /** Test seams: start from a draft / on the review step. */
  initialDraft?: EpisodeDraft; initialStep?: "edit" | "review";
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"tts" | "upload">(initialDraft?.mode ?? "tts");
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [script, setScript] = useState(initialDraft?.script ?? "");
  const [language, setLanguage] = useState<"es" | "en">(initialDraft?.language ?? "es");
  const [voiceId, setVoiceId] = useState(initialDraft?.voiceId ?? voices[0]?.voiceId ?? "");
  const [step, setStep] = useState<"edit" | "review">(initialStep ?? "edit");
  const [restored, setRestored] = useState(false);
  const [hydrated, setHydrated] = useState(!!initialDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chars = script.trim().length;
  const voice = voices.find((v) => v.voiceId === voiceId);
  // Draft kept in this tab (sessionStorage) so going back, an error or a reload never loses the script.
  useEffect(() => {
    if (initialDraft) return;
    // sessionStorage only exists after mount (not during the server render), so the draft can only be restored here.
    const d = readDraft(maxChars);
    if (d) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see the comment above
      setMode(d.mode); setTitle(d.title); setScript(d.script); setLanguage(d.language);
      if (voices.some((v) => v.voiceId === d.voiceId)) setVoiceId(d.voiceId);
      setRestored(true);
    }
    setHydrated(true);
  }, [initialDraft, maxChars, voices]);
  useEffect(() => {
    if (hydrated) writeDraft(title || script ? { v: 1, mode, title, script, language, voiceId } : null);
  }, [hydrated, mode, title, script, language, voiceId]);
  const canReview = !!title.trim() && !(mode === "tts" && (chars < 20 || !voice || !!voicesError));

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/podcast", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "upload" ? { source: "upload", title, language } : { title, script, language, voiceId }) });
      const out = await safeParseJsonResponse<{ id: string }>(res);
      if (!out.ok) throw new Error(out.error);
      writeDraft(null);
      router.push(`/dashboard/podcast/${out.data.id}`);
    } catch (e) {
      setError(classifyClientFetchError(e));
      setBusy(false);
    }
  }

  const input = "w-full rounded border border-border-strong bg-surface-raised px-2 py-1 text-sm";
  if (step === "review") {
    const rows: Array<[string, string]> = [
      ["Título", title.trim()],
      ["Idioma", language === "en" ? "Inglés" : "Español"],
      ["Narración", mode === "upload" ? "Tu propia grabación (un narrador; la subes después de crear)" : `Un narrador · voz guardada «${voice?.name ?? "—"}»`],
      ...(mode === "tts" ? [["Guion", `${chars.toLocaleString("es-MX")} caracteres · ≈ ${Math.max(1, Math.round(chars / 15 / 60))} min de audio`] as [string, string],
        ["Costo estimado de la narración", `${USD.format((chars / 1000) * usdPer1kChars)} (se cobra solo al generar, tras comprobar la capacidad)`] as [string, string]] : []),
      ["Siguiente paso", "Se crea el borrador; no genera ni cobra. Después fijas el presupuesto y revisas la producción antes de iniciarla."],
    ];
    return (
      <Card className="mt-4 p-4 text-sm">
        <h2 className="text-base font-semibold text-ink">Revisa el episodio</h2>
        <dl className="mt-2 grid grid-cols-[11rem_1fr] gap-y-1">
          {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-muted">{k}</dt><dd className="text-ink">{v}</dd></div>)}
        </dl>
        {mode === "tts" && <details className="mt-2"><summary className="cursor-pointer">Ver guion</summary><p className="mt-1 whitespace-pre-wrap break-words">{script.trim()}</p></details>}
        {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={create} loading={busy} disabled={!canReview}>Crear episodio (no genera ni cobra)</Button>
          <Button type="button" variant="secondary" onClick={() => { setError(null); setStep("edit"); }} disabled={busy}>Volver a editar</Button>
        </div>
      </Card>
    );
  }
  return (
    <Card className="mt-4 p-4">
      {restored && <p role="status" className="mb-2 text-xs text-ink-muted">Recuperamos el borrador que estabas escribiendo en esta pestaña.</p>}
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
      <p className="mt-3 text-xs text-ink-muted">Narración: un narrador. Los episodios con dos narradores todavía no se producen en la plataforma.</p>
      {mode === "upload" && <p className="mt-3 text-xs text-ink-muted">Después de crear el episodio podrás subir el archivo (MP3, M4A, WAV, WebM u Ogg; hasta 150 MB). Se normaliza el volumen; no se clona ninguna voz.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <Button type="button" onClick={() => setStep("review")} disabled={!canReview} className="mt-4">
        Revisar antes de crear
      </Button>
    </Card>
  );
}
