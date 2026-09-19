"use client";

import { useState } from "react";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
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

export function NewVideoForm({ action }: { action: (formData: FormData) => void }) {
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

      <SubmitButton />
    </form>
  );
}
