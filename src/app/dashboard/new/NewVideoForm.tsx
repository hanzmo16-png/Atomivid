"use client";

import { useEffect, useRef, useState } from "react";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { AvatarFields } from "./AvatarFields";
import { SubmitButton } from "./SubmitButton";
import { avatarDurationSelectorApplies } from "./validation";
import { availableVideoDurations } from "@/lib/video/avatar/duration";
import { fitForDuration, fitForMaximum, MAX_NARRATION_CHARS, narrationStats } from "@/lib/video/narration-fit";
import { NarrationFitMeter } from "@/components/video/NarrationFitMeter";
import { ChecklistView, useProductionCheck } from "@/components/video/ProductionChecklist";
import { acquireDraftKey, browserStorage, DRAFT_KEY_STORAGE, newKey, rotateDraftKey } from "./draft-key";

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
type ScriptChoice = "generated" | "own" | "adapt";

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
  maxAvatarDurationSeconds = 45,
}: {
  action: (formData: FormData) => void;
  avatarModeEnabled: boolean;
  existingAvatars: { id: string; name: string }[];
  /** Preselecciona "Video con avatar" cuando se llega desde ese tipo en el selector "¿Qué quieres crear?" (ContentTypeStep) — solo tiene efecto si avatarModeEnabled también es true. */
  initialMode?: VideoMode;
  maxAvatarDurationSeconds?: number;
}) {
  const [mode, setMode] = useState<VideoMode>(avatarModeEnabled ? initialMode : "visual");
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [duration, setDuration] = useState(30);
  // Elevado desde AvatarFields (ver ese archivo) para poder ocultar el
  // selector 30/60/90 de aquí abajo cuando corresponda — contrato de
  // duración (RC QA 2026-09-25): "recording"/"tts_text" usan la duración
  // real del audio, nunca este objetivo; "tts" (guion generado) sí lo usa
  // como objetivo, sin cambios.
  const [avatarNarrationSource, setAvatarNarrationSource] = useState("tts");
  const durationSelectorApplies = avatarDurationSelectorApplies(mode, avatarNarrationSource);
  const availableDurations = availableVideoDurations(mode, maxAvatarDurationSeconds);
  // Switching from a longer Reel to Avatar cannot retain an invalid hidden target.
  const selectedDuration = availableDurations.includes(duration) ? duration : (availableDurations[0] ?? 30);

  // One key per DRAFT, shared by every tab of this browser (draft-key.ts): a double click, a browser resend, a
  // second tab or a re-submit after a lost response sends the same key, and the server maps the same key and
  // intent to the same request (submission-key.ts). It rotates only after the server confirmed the creation.
  // Without storage each tab keeps its own key (the first value), as before.
  // The key is taken under the browser's cross-tab lock (acquireDraftKey). `?reset=<key>` (a stale claim, see
  // new-photo-claim.ts) starts a new draft, and only if that key is still the stored one.
  const [submissionId, setSubmissionId] = useState(newKey);
  const [draftReady, setDraftReady] = useState(false);
  const submissionIdRef = useRef(submissionId);
  const syncVersion = useRef(0);
  useEffect(() => {
    let alive = true;
    const sync = () => {
      setDraftReady(false);
      const version = ++syncVersion.current;
      void acquireDraftKey(browserStorage(), submissionIdRef.current).then(k => {
        if (alive && version === syncVersion.current) {
          submissionIdRef.current = k;
          setSubmissionId(k);
          setDraftReady(Boolean(k));
        }
      }).catch(() => { if (alive && version === syncVersion.current) setDraftReady(false); });
    };
    try { rotateDraftKey(browserStorage(), new URLSearchParams(window.location.search).get("reset")); } catch { /* no URL access: nothing to reset */ }
    sync();
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === DRAFT_KEY_STORAGE) sync(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", sync);
    return () => { alive = false; window.removeEventListener("storage", onStorage); window.removeEventListener("focus", sync); };
  }, []);

  // Checklist antes de generar (2026-10-18): «Crea mi guion» / «Usar mi propio guion», and the data the
  // server checks before the first paid call. Every change re-runs the check; an old answer is never current.
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [scriptChoice, setScriptChoice] = useState<ScriptChoice>("generated");
  const [ownText, setOwnText] = useState("");
  const [adaptAccepted, setAdaptAccepted] = useState(false);
  const [ttsText, setTtsText] = useState("");
  const visualOwn = mode === "visual" && scriptChoice !== "generated";
  const textForCheck = mode === "visual" ? (visualOwn ? ownText : "") : avatarNarrationSource === "tts_text" ? ttsText : "";
  const payload = { mode, topic, style, durationSeconds: selectedDuration, language, scriptChoice: mode === "visual" ? scriptChoice : "generated",
    ownText: textForCheck, adaptAccepted, avatarNarrationSource };
  const checkEnabled = Boolean(topic.trim() && style);
  const checkState = useProductionCheck(payload, checkEnabled);
  // The same functions the server enforces (form-production.ts → narration-fit.ts).
  // Fit of the own text (shown while «own» or «adapt» is chosen); it only BLOCKS when the text is narrated as is.
  const ownFit = visualOwn ? fitForDuration(narrationStats(ownText, language, "visual"), selectedDuration, availableDurations) : null;
  const localFit = mode === "visual" ? (scriptChoice === "own" ? ownFit : null)
    : avatarNarrationSource === "tts_text" ? fitForMaximum(narrationStats(ttsText, language, "avatar"), maxAvatarDurationSeconds) : null;
  const submitPays = mode === "avatar" && avatarNarrationSource === "tts_text";
  const check = checkState.status === "done" ? checkState.check : null;
  const disabledReason = !draftReady ? "Sincronizando borrador entre pestañas…" : localFit && !localFit.allowed ? "Corrige el texto o la duración antes de continuar; no se ha gastado nada."
    : mode === "visual" && scriptChoice === "adapt" && !adaptAccepted ? "Acepta el costo de adaptar tu texto con IA o elige otra opción."
    : checkEnabled && checkState.status === "checking" ? "Comprobando datos, plan y recursos…"
    : check && check.outcome !== "ready" && (check.responsible === "cliente" || submitPays) ? check.next
    : null;

  return (
    <form action={action} onSubmit={event => { if (!draftReady) event.preventDefault(); }} className="space-y-5">
      <input type="hidden" name="submission_id" value={draftReady ? submissionId : ""} disabled={!draftReady} />
      {mode === "visual" && (
        <fieldset className="space-y-2.5">
          <legend className="text-sm font-medium text-ink">Guion</legend>
          <input type="hidden" name="script_choice" value={scriptChoice} />
          <div className="grid gap-2.5 sm:grid-cols-2" role="radiogroup" aria-label="Guion">
            {([
              { value: "generated", title: "Crea mi guion", desc: "Escribe el tema o instrucciones; Atomicvid redacta el guion para la duración elegida." },
              { value: "own", title: "Usar mi propio guion", desc: "Pega el texto que quieres narrar; no lo reescribimos ni recortamos." },
            ] as const).map(option => {
              const active = option.value === "generated" ? scriptChoice === "generated" : scriptChoice !== "generated";
              return (
                <button key={option.value} type="button" role="radio" aria-checked={active}
                  onClick={() => { setScriptChoice(option.value); setAdaptAccepted(false); }}
                  className={`flex flex-col gap-0.5 rounded-md border px-4 py-3 text-left text-sm transition-colors ${active ? "border-accent-border bg-accent-soft" : "border-border-strong bg-surface-raised"}`}>
                  <span className="font-medium text-ink">{option.title}</span>
                  <span className="text-xs text-ink-muted">{option.desc}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <Field id="topic" label={visualOwn ? "Título del video" : "Tema o instrucciones"}
        hint={visualOwn ? "Solo para identificar el video; no se narra." : "Orienta el guion. Su longitud no cambia la duración del video: esa la eliges abajo."}>
        <textarea
          id="topic"
          name="topic"
          required
          rows={visualOwn ? 1 : 3}
          maxLength={500}
          className={INPUT_CLASS}
          placeholder={visualOwn ? "Ej: Mi historia de los lunes" : "Ej: 5 datos curiosos sobre el espacio que no sabías"}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
      </Field>

      {visualOwn && (
        <Field id="own_script_text" label="Tu guion (texto a narrar)" hint={`Se narra tal cual. Solo se unifican espacios repetidos. Hasta ${MAX_NARRATION_CHARS} caracteres.`}>
          <textarea id="own_script_text" name="own_script_text" required rows={7} maxLength={MAX_NARRATION_CHARS} className={INPUT_CLASS}
            placeholder="Pega aquí el texto exacto que quieres que se narre…" value={ownText} onChange={(e) => setOwnText(e.target.value)} />
          <NarrationFitMeter text={ownText} language={language} mode="visual" targetSeconds={selectedDuration}
            offeredDurations={availableDurations} onSelectDuration={setDuration} />
          {ownText.trim() && ownFit && (ownFit.verdict !== "compatible" || scriptChoice === "adapt") && (
            <div className="mt-2 rounded-md border border-border-strong bg-surface-raised p-3 text-xs text-ink-muted">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 size-4" checked={scriptChoice === "adapt"}
                  onChange={(e) => { setScriptChoice(e.target.checked ? "adapt" : "own"); setAdaptAccepted(false); }} />
                <span><span className="font-medium text-ink">Adaptar con IA a {selectedDuration} segundos.</span> La IA ajusta tu texto a la duración conservando sus ideas, datos y tono. Tiene costo y verás el resultado antes de generar el video.</span>
              </label>
              {scriptChoice === "adapt" && (
                <label className="mt-2 flex items-start gap-2">
                  <input type="checkbox" name="adapt_accepted" className="mt-0.5 size-4" checked={adaptAccepted} onChange={(e) => setAdaptAccepted(e.target.checked)} />
                  <span>Acepto que se adapte con IA{check?.estimate ? `; el techo estimado de esta producción es hasta USD ${check.estimate.ceilingUsd.toFixed(2)}` : ""} (estimación conservadora, no el precio exacto).</span>
                </label>
              )}
            </div>
          )}
        </Field>
      )}

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

      {/* El hidden siempre se envía para validar el objetivo del formulario, pero el
          selector visible solo tiene sentido cuando SÍ representa la
          duración objetivo real: Reel (mode visual) y Avatar con "Generar
          voz desde el guion". Con "Grabar o subir mi voz"/"Voz IA desde
          texto" el video dura lo que dure el audio real, nunca este valor
          — mostrarlo ahí invitaría a pensar que se puede truncar/rellenar
          a 30/60/90, que es exactamente el bug que este contrato corrige. */}
      <input type="hidden" id="duration_seconds" name="duration_seconds" value={selectedDuration} />
      {durationSelectorApplies ? (
        <Field id="duration_seconds_picker" label="Duración deseada">
          <div className="inline-flex rounded-md border border-border-strong bg-surface-raised p-1" role="radiogroup" aria-label="Duración deseada">
            {DURATIONS.filter(d => availableDurations.includes(d.value)).map((d) => (
              <button
                key={d.value}
                type="button"
                role="radio"
                aria-checked={selectedDuration === d.value}
                onClick={() => setDuration(d.value)}
                className={`rounded-sm px-4 py-1.5 text-sm font-medium transition-colors ${
                  selectedDuration === d.value ? "bg-accent text-accent-ink" : "text-ink-muted hover:text-ink"
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
        <>
          <p className="text-sm text-ink-muted">Límite de Avatar: {maxAvatarDurationSeconds} segundos. El guion o la grabación deben caber en ese tiempo.</p>
          <AvatarFields
            existingAvatars={existingAvatars}
            language={language}
            narrationSource={avatarNarrationSource}
            onNarrationSourceChange={setAvatarNarrationSource}
            ttsText={ttsText}
            onTtsTextChange={setTtsText}
            maxAvatarDurationSeconds={maxAvatarDurationSeconds}
          />
        </>
      )}

      <section aria-labelledby="pre-check-title" className="space-y-2 rounded-md border border-border p-4">
        <h2 id="pre-check-title" className="text-sm font-medium text-ink">Comprobación antes de gastar</h2>
        {!checkEnabled ? (
          <p className="text-sm text-ink-muted">Completa el tema y el estilo para comprobar plan, proveedores y presupuesto.</p>
        ) : check ? (
          <ChecklistView check={check} />
        ) : checkState.status === "failed" ? (
          <p className="text-sm text-ink-muted" role="status">No pudimos comprobar ahora los recursos. Puedes guardar la solicitud: antes de cualquier paso con costo se vuelve a comprobar en el servidor y, si no se confirma, no se gasta nada.</p>
        ) : (
          <>
            {checkState.check && <ChecklistView check={checkState.check} stale />}
            <p className="text-sm text-ink-muted" role="status">Comprobando con los datos actuales…</p>
          </>
        )}
        {check && check.outcome !== "ready" && check.responsible === "atomicvid" && !submitPays && (
          <p className="text-xs text-ink-muted">Puedes guardar la solicitud: crearla no tiene costo y no se generará nada hasta que se resuelva.</p>
        )}
      </section>

      <SubmitButton disabledReason={disabledReason} />
    </form>
  );
}
