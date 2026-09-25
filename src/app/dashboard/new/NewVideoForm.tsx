"use client";

import { useState } from "react";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { AvatarFields } from "./AvatarFields";
import { SubmitButton } from "./SubmitButton";

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
}: {
  action: (formData: FormData) => void;
  avatarModeEnabled: boolean;
  existingAvatars: { id: string; name: string }[];
  /** Preselecciona "Video con avatar" cuando se llega desde ese tipo en el selector "¿Qué quieres crear?" (ContentTypeStep) — solo tiene efecto si avatarModeEnabled también es true. */
  initialMode?: VideoMode;
}) {
  const [mode, setMode] = useState<VideoMode>(avatarModeEnabled ? initialMode : "visual");
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [duration, setDuration] = useState(30);

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

      <Field id="style" label="Estilo / tono">
        <select id="style" name="style" required defaultValue="" className={INPUT_CLASS}>
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

      <Field id="duration_seconds" label="Duración deseada">
        <input type="hidden" id="duration_seconds" name="duration_seconds" value={duration} />
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
        <AvatarFields existingAvatars={existingAvatars} language={language} />
      )}

      <SubmitButton />
    </form>
  );
}
