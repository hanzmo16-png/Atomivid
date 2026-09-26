"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { VoiceSelector, type CustomVoiceOption } from "@/components/voice/VoiceSelector";
import { billableCharacters, countWords, estimateDurationRange, fitsTtsLimits, formatCount, formatDurationRange, segmentScript, TTS_TITLE_MAX } from "@/lib/tts/segment";
import { MUSIC_CHOICES, type MusicChoice } from "@/lib/tts/music-beds";

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} disabled={disabled} className="w-full" size="lg">
      {pending ? "Enviando…" : "Generar audio"}
    </Button>
  );
}

/**
 * Formulario de «Texto a voz». Las cifras (palabras, caracteres, duración
 * estimada, si cabe en los límites) salen de la misma lógica que valida el
 * servidor; el servidor vuelve a validar todo. client_request_id se fija al
 * abrir el formulario: un doble clic o un reenvío devuelven la misma pieza,
 * nunca dos.
 */
export function TtsForm({
  action,
  maxCharsPerPiece,
  maxCharsPerUserMonth,
  usedThisMonth,
  longPilot,
  provider,
  musicEnabled,
  customVoices,
  clientRequestId,
}: {
  action: (formData: FormData) => void;
  /** Generado por el servidor al abrir la página (evita un id distinto entre servidor y navegador). */
  clientRequestId: string;
  maxCharsPerPiece: number;
  maxCharsPerUserMonth: number;
  usedThisMonth: number;
  /** Cuenta del piloto de episodios largos. */
  longPilot: boolean;
  /** Saldo del servicio de voz (solo piloto); null = no se pudo consultar. */
  provider: { remaining: number; reserve: number; resetsAt: string | null } | null;
  musicEnabled: boolean;
  customVoices: CustomVoiceOption[];
}) {
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [script, setScript] = useState("");
  const [music, setMusic] = useState<MusicChoice>("none");
  const estimate = useMemo(() => {
    const segments = segmentScript(script);
    const words = segments.reduce((sum, s) => sum + countWords(s.text), 0);
    return { characters: billableCharacters(segments), words, range: estimateDurationRange(words) };
  }, [script]);
  const remainingThisMonth = Math.max(0, maxCharsPerUserMonth - usedThisMonth);
  const fit = fitsTtsLimits(estimate.characters, { maxCharsPerPiece, maxCharsPerUserMonth, usedThisMonth });
  const providerAvailable = provider ? Math.max(0, provider.remaining - provider.reserve) : null;
  const providerShort = longPilot && providerAvailable !== null && estimate.characters > providerAvailable;

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="client_request_id" value={clientRequestId} />
      <Field id="tts-title" label="Título">
        <input id="tts-title" name="title" required maxLength={TTS_TITLE_MAX} className={INPUT_CLASS} placeholder="Ej.: Introducción del episodio 12" />
      </Field>
      <Field id="tts-language" label="Idioma">
        <select id="tts-language" name="language" value={language} onChange={(e) => setLanguage(e.target.value === "en" ? "en" : "es")} className={INPUT_CLASS}>
          <option value="es">Español</option>
          <option value="en">Inglés</option>
        </select>
      </Field>
      <VoiceSelector language={language} customVoices={customVoices} legend="Voz (un narrador por pieza)" />
      <Field id="tts-script" label="Texto" hint="Separa los párrafos con una línea en blanco: entre párrafos se deja una pausa natural.">
        <textarea
          id="tts-script"
          name="script"
          required
          rows={longPilot ? 16 : 10}
          value={script}
          onChange={(e) => setScript(e.target.value)}
          className={`${INPUT_CLASS} min-h-48 resize-y leading-relaxed`}
          placeholder="Pega o escribe aquí el texto que quieres convertir en voz."
        />
      </Field>
      {musicEnabled && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">Acompañamiento</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {MUSIC_CHOICES.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer flex-col rounded-md border px-3 py-2 text-sm ${music === option.value ? "border-accent bg-accent/5" : "border-border"}`}
              >
                <span className="flex items-center gap-2 font-medium text-ink">
                  <input type="radio" name="music" value={option.value} checked={music === option.value} onChange={() => setMusic(option.value)} className="accent-accent" />
                  {option.label}
                </span>
                <span className="mt-0.5 text-xs text-ink-faint">{option.description}</span>
              </label>
            ))}
          </div>
          {music !== "none" && <p className="text-xs text-ink-faint">Recibirás dos archivos: la narración sola y el podcast con música.</p>}
        </fieldset>
      )}
      <dl className="grid grid-cols-2 gap-3 rounded-md border border-border bg-surface px-4 py-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-ink-faint">Palabras</dt>
          <dd className="font-medium text-ink">{formatCount(estimate.words)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Caracteres</dt>
          <dd className={`font-medium ${fit.ok ? "text-ink" : "text-danger"}`}>
            {formatCount(estimate.characters)} / {formatCount(Math.min(maxCharsPerPiece, remainingThisMonth))}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-ink-faint">Duración aproximada (estimación)</dt>
          <dd className="font-medium text-ink">{estimate.words ? formatDurationRange(estimate.range) : "—"}</dd>
        </div>
      </dl>
      <div className="space-y-1 text-xs text-ink-faint">
        <p>
          Estimación a 120–140 palabras por minuto con pausas breves; la duración real depende de la voz y se mide al terminar. El audio no se recorta, acelera ni
          rellena para llegar a una duración.
        </p>
        <p>
          Consumo: {formatCount(estimate.characters)} caracteres. Máximo por pieza: {formatCount(maxCharsPerPiece)}. Te quedan este mes: {formatCount(remainingThisMonth)} de{" "}
          {formatCount(maxCharsPerUserMonth)}.
          {longPilot && provider && (
            <>
              {" "}
              Saldo del servicio de voz: {formatCount(provider.remaining)} caracteres{provider.resetsAt ? ` (se renueva el ${provider.resetsAt})` : ""}; se reservan{" "}
              {formatCount(provider.reserve)} para el resto de Atomivid.
            </>
          )}
          {longPilot && !provider && " No se pudo consultar el saldo del servicio de voz ahora; se comprueba antes de generar."}
        </p>
      </div>
      {!fit.ok && estimate.characters > 0 && (
        <p className="text-sm text-danger" role="alert">
          {fit.reason === "piece" ? `El máximo por pieza es ${formatCount(fit.max)} caracteres.` : "El texto supera los caracteres que te quedan este mes."}
        </p>
      )}
      {fit.ok && providerShort && (
        <p className="text-sm text-danger" role="alert">
          El servicio de voz no tiene caracteres suficientes ahora para este texto (quedan {formatCount(providerAvailable ?? 0)} disponibles).
        </p>
      )}
      <Submit disabled={!estimate.characters || !fit.ok || providerShort} />
    </form>
  );
}
