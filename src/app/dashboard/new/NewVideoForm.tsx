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
  { value: 30, label: "30 segundos" },
  { value: 60, label: "60 segundos" },
  { value: 90, label: "90 segundos" },
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
}: {
  action: (formData: FormData) => void;
  avatarModeEnabled: boolean;
  existingAvatars: { id: string; name: string }[];
}) {
  const [mode, setMode] = useState<VideoMode>("visual");
  const [language, setLanguage] = useState<"es" | "en">("es");

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
        <select id="duration_seconds" name="duration_seconds" required defaultValue={30} className={INPUT_CLASS}>
          {DURATIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </Field>

      {avatarModeEnabled && (
        <fieldset className="space-y-2.5">
          <legend className="text-sm font-medium text-ink">Tipo de video</legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="radio"
                name="mode"
                value="visual"
                checked={mode === "visual"}
                onChange={() => setMode("visual")}
                className="size-4"
              />
              Video visual (clips e imágenes)
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="radio"
                name="mode"
                value="avatar"
                checked={mode === "avatar"}
                onChange={() => setMode("avatar")}
                className="size-4"
              />
              Video con avatar (tu fotografía narra el guion)
            </label>
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
