"use client";

import { useState } from "react";
import { INPUT_CLASS } from "@/components/ui/Field";
import {
  DEFAULT_PROFILE,
  INTENTS,
  INTENT_IDS,
  MOTION_MODES,
  MOTION_MODE_IDS,
  MUSIC_DIRECTIONS,
  MUSIC_DIRECTION_IDS,
  PACES,
  PACE_IDS,
  PROFILES,
  PROFILE_IDS,
  PROFILE_SAMPLES,
  previewSummary,
  type AudiovisualSelection,
  type IntentId,
  type MotionMode,
  type MusicChoice,
  type PaceId,
  type ProfileId,
} from "@/lib/video/audiovisual/catalog";

/** Disponibilidad por perfil, calculada en el servidor (flags, proveedor, presupuesto). */
export type ProfileAvailability = Partial<Record<ProfileId, { ok: boolean; note?: string }>>;

/** Disponibilidad y costo estimado de «Animación IA» para la duración elegida (calculado en el servidor). */
export type AnimationAvailability = { ok: boolean; note?: string; estimatedUsd: number; clips: number };

/**
 * Selector de dirección audiovisual: cinco tarjetas, un resumen de una
 * línea y «Ajustes» opcionales cerrados. Envía av_profile/av_intent/
 * av_music/av_pace dentro del <form> que lo contiene; el servidor
 * (catalog.ts, parseSelection) es quien valida de verdad.
 */
export function AudiovisualSelector({
  style,
  availability = {},
  animation,
  initial,
  disabled = false,
}: {
  /** Tono del contenido elegido en el mismo formulario — afina el resumen. */
  style?: string;
  availability?: ProfileAvailability;
  /** Ausente = «Animación IA» no disponible (se muestra bloqueada con el motivo). */
  animation?: AnimationAvailability;
  initial?: AudiovisualSelection;
  disabled?: boolean;
}) {
  const [profile, setProfile] = useState<ProfileId>(initial?.profile ?? DEFAULT_PROFILE);
  const [intent, setIntent] = useState<IntentId | "auto">(initial?.intent ?? "auto");
  const [music, setMusic] = useState<MusicChoice | "auto">(initial?.music ?? "auto");
  const [pace, setPace] = useState<PaceId | "auto">(initial?.pace ?? "auto");
  const [motion, setMotion] = useState<MotionMode>(initial?.motion === "ai_animation" ? "ai_animation" : "images");
  const animationOk = animation?.ok === true;
  const def = PROFILES[profile];

  const allowedIntents = def.allowedIntents ?? INTENT_IDS;
  const allowedMusic = def.allowedMusic ?? [...MUSIC_DIRECTION_IDS, "none" as const];
  const effectiveIntent = intent !== "auto" && allowedIntents.includes(intent) ? intent : "auto";
  const effectiveMusic = music !== "auto" && allowedMusic.includes(music) ? music : "auto";

  const selection: AudiovisualSelection = {
    version: 1,
    profile,
    ...(effectiveIntent !== "auto" ? { intent: effectiveIntent } : {}),
    ...(effectiveMusic !== "auto" ? { music: effectiveMusic } : {}),
    ...(pace !== "auto" ? { pace } : {}),
    ...(motion === "ai_animation" ? { motion: "ai_animation" as const } : {}),
  };
  const summary = previewSummary(selection, style);
  const currentUnavailable = availability[profile]?.ok === false;
  const horrorOverridesTone = profile === "horror_mystery" && style && style !== "Historias de terror";

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium text-ink">Dirección visual</legend>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label="Dirección visual">
        {PROFILE_IDS.map((id) => {
          const p = PROFILES[id];
          const avail = availability[id] ?? { ok: true };
          const selected = profile === id;
          const sample = PROFILE_SAMPLES[id];
          return (
            <label
              key={id}
              className={`flex min-h-[104px] flex-col gap-1 rounded-md border px-3 py-2.5 text-sm transition-colors ${
                !avail.ok
                  ? "cursor-not-allowed border-border bg-surface opacity-60"
                  : selected
                    ? "cursor-pointer border-accent-border bg-accent-soft"
                    : "cursor-pointer border-border-strong bg-surface-raised hover:border-accent-border"
              }`}
            >
              <span className="flex items-center gap-2 font-medium text-ink">
                <input
                  type="radio"
                  name="av_profile"
                  value={id}
                  checked={selected}
                  aria-disabled={!avail.ok}
                  onChange={() => {
                    if (avail.ok) setProfile(id);
                  }}
                  className="size-4 shrink-0 accent-accent"
                />
                {p.label}
              </span>
              <span className="text-xs leading-snug text-ink-muted">{p.description}</span>
              {!avail.ok && avail.note && <span className="text-xs leading-snug text-warning">{avail.note}</span>}
              {sample ? (
                // eslint-disable-next-line @next/next/no-img-element -- muestra real, tamaño fijo pequeño
                <img src={sample.src} alt={sample.alt} className="mt-1 aspect-[9/16] w-12 rounded-sm object-cover" />
              ) : (
                <span className="mt-auto text-[11px] text-ink-faint">Muestra real pendiente</span>
              )}
            </label>
          );
        })}
      </div>

      <p className="rounded-md bg-surface-raised px-3 py-2 text-sm text-ink" aria-live="polite" data-testid="av-summary">
        {summary}
      </p>
      {currentUnavailable && (
        <p className="text-xs text-warning" role="alert">
          «{def.label}» no está disponible con esta duración. Elige otra dirección o una duración menor.
        </p>
      )}
      {horrorOverridesTone && (
        <p className="text-xs text-ink-muted">«Horror y misterio» mantiene el suspenso aunque el tono elegido sea «{style}».</p>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-ink">Movimiento</legend>
        <input type="hidden" name="av_motion" value={motion} />
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" role="radiogroup" aria-label="Movimiento">
          {MOTION_MODE_IDS.map((id) => {
            const locked = id === "ai_animation" && !animationOk;
            const selected = motion === id;
            return (
              <label
                key={id}
                className={`flex flex-col gap-1 rounded-md border px-3 py-2.5 text-sm ${
                  locked
                    ? "cursor-not-allowed border-border bg-surface opacity-60"
                    : selected
                      ? "cursor-pointer border-accent-border bg-accent-soft"
                      : "cursor-pointer border-border-strong bg-surface-raised hover:border-accent-border"
                }`}
              >
                <span className="flex items-center gap-2 font-medium text-ink">
                  <input
                    type="radio"
                    name="av_motion_choice"
                    value={id}
                    checked={selected}
                    aria-disabled={locked}
                    onChange={() => {
                      if (!locked) setMotion(id);
                    }}
                    className="size-4 shrink-0 accent-accent"
                  />
                  {MOTION_MODES[id].label}
                </span>
                <span className="text-xs leading-snug text-ink-muted">{MOTION_MODES[id].description}</span>
                {id === "ai_animation" &&
                  (locked ? (
                    <span className="text-xs leading-snug text-warning">{animation?.note ?? "Aún no disponible"}</span>
                  ) : (
                    <span className="text-xs leading-snug text-ink-muted" data-testid="av-animation-cost">
                      Costo estimado: ~US${animation!.estimatedUsd.toFixed(2)} ({animation!.clips} clips animados de 8 s y sus ilustraciones).
                    </span>
                  ))}
              </label>
            );
          })}
        </div>
      </fieldset>
      {motion === "images" && def.visualSource === "generated_image" && (
        <p className="text-xs text-ink-muted">
          Cada escena se ilustra con este estilo (imagen fija con movimiento de cámara, no animación generada). Si no se puede ilustrar, la
          producción se detiene y te avisa: nunca se cambia a clips reales sin preguntarte.
        </p>
      )}
      {motion === "ai_animation" && (
        <p className="text-xs text-ink-muted">
          Cada escena parte de una ilustración con el estilo «{def.label}» y se anima con movimiento real dentro de la escena. Si una animación
          falla, la producción se detiene y te avisa: nunca se sustituye por una imagen fija con zoom.
        </p>
      )}

      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-ink">Ajustes adicionales (opcional)</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-ink-muted">
            Intención
            <select
              name="av_intent"
              value={effectiveIntent}
              onChange={(e) => setIntent(e.target.value as IntentId | "auto")}
              className={`${INPUT_CLASS} mt-1`}
            >
              <option value="auto">{def.intentPreset ? `${INTENTS[def.intentPreset].label} (del perfil)` : "Automática (según tu guion)"}</option>
              {allowedIntents
                .filter((i) => i !== def.intentPreset)
                .map((i) => (
                  <option key={i} value={i}>
                    {INTENTS[i].label}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            Música
            <select name="av_music" value={effectiveMusic} onChange={(e) => setMusic(e.target.value as MusicChoice | "auto")} className={`${INPUT_CLASS} mt-1`}>
              <option value="auto">Automática</option>
              {allowedMusic.map((m) => (
                <option key={m} value={m}>
                  {m === "none" ? "Sin música" : MUSIC_DIRECTIONS[m].label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            Ritmo
            <select name="av_pace" value={pace} onChange={(e) => setPace(e.target.value as PaceId | "auto")} className={`${INPUT_CLASS} mt-1`}>
              <option value="auto">Automático</option>
              {PACE_IDS.map((p) => (
                <option key={p} value={p}>
                  {PACES[p].label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-ink-faint">La voz y el idioma que elegiste no cambian.</p>
      </details>
    </fieldset>
  );
}
