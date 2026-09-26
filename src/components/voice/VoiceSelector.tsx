"use client";

import { useState } from "react";
import { CATALOG_VOICE_IDS, DEFAULT_VOICE_ID, VOICE_CATALOG, catalogLanguageIssue, type VoiceLanguage } from "@/lib/voices/catalog";

export type CustomVoiceOption = { id: string; name: string };

/**
 * Selector de voz de narración: las cinco voces del catálogo y, si el
 * usuario tiene, sus voces privadas listas («Mi voz»). Envía `voice_choice`
 * («mateo», «miguel»… o «custom:<uuid>»); el servidor vuelve a validar la
 * elección y la propiedad. Una voz que no admite el idioma se muestra
 * deshabilitada con el motivo (nunca se cambia sola por otra).
 */
export function VoiceSelector({
  language,
  customVoices = [],
  name = "voice_choice",
  legend = "Voz de la narración",
}: {
  language: VoiceLanguage;
  customVoices?: CustomVoiceOption[];
  name?: string;
  legend?: string;
}) {
  const [chosen, setValue] = useState<string>(DEFAULT_VOICE_ID);
  // Si cambia el idioma y la voz elegida no lo admite, se muestra (y envía) la voz por defecto de forma visible.
  const value =
    (CATALOG_VOICE_IDS as string[]).includes(chosen) && catalogLanguageIssue(chosen as (typeof CATALOG_VOICE_IDS)[number], language)
      ? DEFAULT_VOICE_ID
      : chosen;

  const options = [
    ...CATALOG_VOICE_IDS.map((id) => {
      const voice = VOICE_CATALOG[id];
      const issue = catalogLanguageIssue(id, language);
      return { value: id, title: voice.label, desc: issue ?? voice.description, disabled: Boolean(issue), badge: voice.gender === "male" ? "Masculina" : "Femenina" };
    }),
    ...customVoices.map((v) => ({ value: `custom:${v.id}`, title: v.name, desc: "Tu voz privada. Solo tú puedes usarla.", disabled: false, badge: "Mi voz" })),
  ];

  return (
    <fieldset className="space-y-2.5">
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" role="radiogroup" aria-label={legend}>
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex flex-col gap-0.5 rounded-md border px-4 py-3 text-sm transition-colors ${
              option.disabled
                ? "cursor-not-allowed border-border bg-surface opacity-60"
                : value === option.value
                  ? "cursor-pointer border-accent-border bg-accent-soft"
                  : "cursor-pointer border-border-strong bg-surface-raised hover:border-border-strong/80"
            }`}
          >
            <span className="flex items-center gap-2 font-medium text-ink">
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                disabled={option.disabled}
                onChange={() => setValue(option.value)}
                className="size-4 accent-accent"
              />
              {option.title}
              <span className="ml-auto rounded-sm bg-surface px-1.5 py-0.5 text-[11px] font-normal text-ink-faint">{option.badge}</span>
            </span>
            <span className="pl-6 text-xs text-ink-muted">{option.desc}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
