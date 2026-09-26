"use client";

import { useState } from "react";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { AvatarFields } from "./AvatarFields";
import { SubmitButton } from "./SubmitButton";
import { avatarDurationSelectorApplies } from "./validation";
import { AudiovisualSelector, type AnimationAvailability, type ProfileAvailability } from "@/components/video/AudiovisualSelector";
import { VoiceSelector, type CustomVoiceOption } from "@/components/voice/VoiceSelector";

const STYLES = [
  "Motivacional",
  "Educativo",
  "Humor",
  "Historias de terror",
  "Curiosidades",
  "Noticias / actualidad",
  "Storytelling personal",
];

const DURATIONS = [
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
  { value: 90, label: "90s" },
];

type VideoMode = "visual" | "avatar";

/**
 * Formulario de /dashboard/new. El selector "Video visual" / "Video con
 * avatar" solo se muestra cuando `avatarModeEnabled` (leído en el
 * servidor, en page.tsx, a partir de AVATAR_MODE_ENABLED) es true — con
 * el flag apagado este componente renderiza exactamente los mismos campos
 * que antes de que existiera el modo avatar, sin ningún control nuevo.
 */
export function NewVideoForm({
  action,
  avatarModeEnabled,
  existingAvatars,
  initialMode = "visual",
  audiovisual,
  voices,
}: {
  action: (formData: FormData) => void;
  avatarModeEnabled: boolean;
  existingAvatars: { id: string; name: string }[];
  /** Preselecciona "Video con avatar" cuando se llega desde ese tipo en el selector "¿Qué quieres crear?" (ContentTypeStep) — solo tiene efecto si avatarModeEnabled también es true. */
  initialMode?: VideoMode;
  /** Dirección audiovisual (AUDIOVISUAL_PROFILES_ENABLED). Ausente = formulario de siempre. Solo aplica a Reel (mode visual). */
  audiovisual?: { availabilityByDuration: Record<number, ProfileAvailability>; animationByDuration?: Record<number, AnimationAvailability> };
  /** Selector de voz (VOICE_CATALOG_ENABLED). Ausente = voz de siempre, sin selector. */
  voices?: { customVoices: CustomVoiceOption[] };
}) {
  const [mode, setMode] = useState<VideoMode>(avatarModeEnabled ? initialMode : "visual");
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [duration, setDuration] = useState(30);
  const [style, setStyle] = useState("");
  // Elevado desde AvatarFields (ver ese archivo) para poder ocultar el
  // selector 30/60/90 de aquí abajo cuando corresponda — contrato de
  // duración (RC QA 2026-09-25): "recording"/"tts_text" usan la duración
  // real del audio, nunca este objetivo; "tts" (guion generado) sí lo usa
  // como objetivo, sin cambios.
  const [avatarNarrationSource, setAvatarNarrationSource] = useState("tts");
  const durationSelectorApplies = avatarDurationSelectorApplies(mode, avatarNarrationSource);

  return (
    <form action={action} className="space-y-5">
      <Field id="topic" label="Tema del video">
        <textarea
          id="topic"
          name="topic"
          required
          rows={3}
          maxLength={500}
          className={INPUT_CLASS}
          placeholder="Ej: 5 datos curiosos sobre el espacio que no sabías"
        />
      </Field>

      <Field id="language" label="Idioma de la narración">
        <select
          id="language"
          name="language"
          required
          value={language}
          onChange={(e) => setLanguage(e.target.value as "es" | "en")}
          className={INPUT_CLASS}
        >
          <option value="es">Español</option>
          <option value="en">English</option>
        </select>
      </Field>

      <Field id="style" label={audiovisual && mode === "visual" ? "Tono del contenido" : "Estilo / tono"}>
        <select id="style" name="style" required value={style} onChange={(e) => setStyle(e.target.value)} className={INPUT_CLASS}>
          <option value="" disabled>
            Selecciona un estilo
          </option>
          {STYLES.map((style) => (
            <option key={style} value={style}>
              {style}
            </option>
          ))}
        </select>
      </Field>

      {audiovisual && mode === "visual" && (
        <AudiovisualSelector
          style={style || undefined}
          availability={audiovisual.availabilityByDuration[duration]}
          animation={audiovisual.animationByDuration?.[duration]}
        />
      )}

      {/* El hidden siempre se envía (fallback si la medición real del audio
          falla en el servidor — ver dashboard/new/actions.ts), pero el
          selector visible solo tiene sentido cuando SÍ representa la
          duración objetivo real: Reel (mode visual) y Avatar con "Generar
          voz desde el guion". Con "Grabar o subir mi voz"/"Voz IA desde
          texto" el video dura lo que dure el audio real, nunca este valor
          — mostrarlo ahí invitaría a pensar que se puede truncar/rellenar
          a 30/60/90, que es exactamente el bug que este contrato corrige. */}
      <input type="hidden" id="duration_seconds" name="duration_seconds" value={duration} />
      {durationSelectorApplies ? (
        <Field id="duration_seconds_picker" label="Duración deseada">
          <div className="inline-flex rounded-md border border-border-strong bg-surface-raised p-1" role="radiogroup" aria-label="Duración deseada">
            {DURATIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                role="radio"
                aria-checked={duration === d.value}
                onClick={() => setDuration(d.value)}
                className={`rounded-sm px-4 py-1.5 text-sm font-medium transition-colors ${
                  duration === d.value ? "bg-accent text-accent-ink" : "text-ink-muted hover:text-ink"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </Field>
      ) : (
        <p className="text-sm text-ink-muted">
          Con esta fuente de voz, el video dura lo mismo que tu audio — no hay una duración objetivo que elegir.
        </p>
      )}

      {avatarModeEnabled && (
        <fieldset className="space-y-2.5">
          <legend className="text-sm font-medium text-ink">Tipo de video</legend>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {(
              [
                { value: "visual", title: "Video visual", desc: "Clips e imágenes reales por escena" },
                { value: "avatar", title: "Video con avatar", desc: "Tu fotografía narra el guion" },
              ] as const
            ).map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer flex-col gap-0.5 rounded-md border px-4 py-3 text-sm transition-colors ${
                  mode === option.value
                    ? "border-accent-border bg-accent-soft"
                    : "border-border-strong bg-surface-raised hover:border-border-strong/80"
                }`}
              >
                <span className="flex items-center gap-2 font-medium text-ink">
                  <input
                    type="radio"
                    name="mode"
                    value={option.value}
                    checked={mode === option.value}
                    onChange={() => setMode(option.value)}
                    className="size-4 accent-accent"
                  />
                  {option.title}
                </span>
                <span className="pl-6 text-xs text-ink-muted">{option.desc}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {avatarModeEnabled && mode === "avatar" && (
        <AvatarFields
          existingAvatars={existingAvatars}
          language={language}
          narrationSource={avatarNarrationSource}
          onNarrationSourceChange={setAvatarNarrationSource}
        />
      )}

      {/* Voz de la narración: Reel y Avatar con voz sintetizada (una grabación propia no usa voz del catálogo). */}
      {voices && (mode === "visual" || avatarNarrationSource !== "recording") && (
        <VoiceSelector language={language} customVoices={voices.customVoices} />
      )}

      <SubmitButton />
    </form>
  );
}
