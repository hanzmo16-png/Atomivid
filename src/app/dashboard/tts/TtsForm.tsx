"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { VoiceSelector, type CustomVoiceOption } from "@/components/voice/VoiceSelector";
import { billableCharacters, estimateSeconds, formatCount, formatDuration, segmentScript, TTS_TITLE_MAX } from "@/lib/tts/segment";

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} disabled={disabled} className="w-full" size="lg">
      {pending ? "Enviando…" : "Generar audio"}
    </Button>
  );
}

/**
 * Formulario de «Texto a voz». La estimación (duración, caracteres,
 * fragmentos) es la misma lógica que usa el servidor; el servidor vuelve a
 * validar todo. client_request_id se fija al abrir el formulario: un doble
 * clic o un reenvío devuelven la misma pieza, nunca dos.
 */
export function TtsForm({
  action,
  maxCharsPerPiece,
  remainingThisMonth,
  customVoices,
  clientRequestId,
}: {
  action: (formData: FormData) => void;
  /** Generado por el servidor al abrir la página (evita un id distinto entre servidor y navegador). */
  clientRequestId: string;
  maxCharsPerPiece: number;
  remainingThisMonth: number;
  customVoices: CustomVoiceOption[];
}) {
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [script, setScript] = useState("");
  const estimate = useMemo(() => {
    const segments = segmentScript(script);
    return { characters: billableCharacters(segments), seconds: estimateSeconds(segments), segments: segments.length };
  }, [script]);
  const limit = Math.min(maxCharsPerPiece, remainingThisMonth);
  const tooLong = estimate.characters > limit;

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
          rows={10}
          value={script}
          onChange={(e) => setScript(e.target.value)}
          className={`${INPUT_CLASS} min-h-48 resize-y leading-relaxed`}
          placeholder="Pega o escribe aquí el texto que quieres convertir en voz."
        />
      </Field>
      <dl className="grid grid-cols-2 gap-3 rounded-md border border-border bg-surface px-4 py-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-faint">Duración estimada</dt>
          <dd className="font-medium text-ink">{estimate.characters ? `≈ ${formatDuration(estimate.seconds)}` : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Consumo</dt>
          <dd className={`font-medium ${tooLong ? "text-danger" : "text-ink"}`}>
            {formatCount(estimate.characters)} / {formatCount(limit)} caracteres
          </dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-xs text-ink-faint">Te quedan este mes</dt>
          <dd className="font-medium text-ink">{formatCount(remainingThisMonth)} caracteres</dd>
        </div>
      </dl>
      {tooLong && (
        <p className="text-sm text-danger" role="alert">
          {estimate.characters > maxCharsPerPiece
            ? `El máximo por pieza es ${formatCount(maxCharsPerPiece)} caracteres.`
            : "El texto supera los caracteres que te quedan este mes."}
        </p>
      )}
      <Submit disabled={!estimate.characters || tooLong} />
    </form>
  );
}
