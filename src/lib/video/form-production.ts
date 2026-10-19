/**
 * The new-video form as the production check sees it. ONE function used by the live checklist endpoint
 * (POST /api/production-check, read-only) and by the server action that creates the request, so what the
 * form shows and what the server enforces cannot drift apart. Pure: no I/O.
 */
import { validateCommonFields, type VideoMode } from "@/app/dashboard/new/validation";
import { availableVideoDurations } from "./avatar/duration";
import { fitForDuration, fitForMaximum, narrationStats, type DurationFit, type NarrationStats } from "./narration-fit";
import { buildOwnScriptDraft, type OwnScriptDraft } from "./own-script";
import type { CheckRequest, ProductionEstimate } from "@/lib/supply/production-check";

export type ScriptChoice = "generated" | "own" | "adapt";
export type FormProductionInput = {
  mode: VideoMode;
  topic: string;
  style: string;
  durationSeconds: number;
  language: string;
  /** Reel: «Crea mi guion» (generated), «Usar mi propio guion» (own), or own text adapted by AI after acceptance. */
  scriptChoice: ScriptChoice;
  ownText: string;
  /** The customer accepted, with its cost shown, that AI adapts their text. */
  adaptAccepted: boolean;
  /** Avatar: tts (script written by Atomicvid), tts_text (own text), recording (own audio). */
  avatarNarrationSource: string;
  maxAvatarSeconds: number;
};

export type FormProduction = {
  inputError: string | null;
  fit: DurationFit | null;
  stats: NarrationStats | null;
  stage: ProductionEstimate["stage"];
  request: CheckRequest;
  draft: OwnScriptDraft | null;
};

export function formProduction(input: FormProductionInput): FormProduction {
  const language: "es" | "en" = input.language === "en" ? "en" : "es";
  const ownTextUsed = input.mode === "visual" ? input.scriptChoice !== "generated" : input.avatarNarrationSource === "tts_text";
  // Avatar text/recording last as long as their audio: the 30/60/90 target only applies to a written script.
  const durationApplies = input.mode === "visual" || input.avatarNarrationSource === "tts";
  let inputError = validateCommonFields({ topic: input.topic, style: input.style, durationSeconds: input.durationSeconds, language: input.language });
  if (!inputError && durationApplies && !availableVideoDurations(input.mode, input.maxAvatarSeconds).includes(input.durationSeconds))
    inputError = "Esa duración no está disponible para esta modalidad.";
  if (!inputError && input.mode === "avatar" && !["tts", "tts_text", "recording"].includes(input.avatarNarrationSource)) inputError = "Fuente de narración no válida.";
  if (!inputError && input.mode === "visual" && !["generated", "own", "adapt"].includes(input.scriptChoice)) inputError = "Opción de guion no válida.";

  const stats = ownTextUsed ? narrationStats(input.ownText, language, input.mode) : null;
  let fit: DurationFit | null = null;
  if (stats && input.mode === "avatar") fit = fitForMaximum(stats, input.maxAvatarSeconds);
  else if (stats && input.scriptChoice === "own") fit = fitForDuration(stats, input.durationSeconds, availableVideoDurations("visual", input.maxAvatarSeconds));
  if (!inputError && stats && !stats.text) inputError = "Escribe o pega el texto que quieres narrar.";
  if (!inputError && input.scriptChoice === "adapt" && input.mode === "visual" && !input.adaptAccepted)
    inputError = "Para adaptar tu texto con IA, primero acepta su costo estimado.";

  const draft = input.mode === "visual" && input.scriptChoice !== "generated" && stats?.text
    ? buildOwnScriptDraft(stats.text, input.topic, input.durationSeconds, input.scriptChoice === "adapt" ? "adapt" : "own") : null;
  const base = { mode: input.mode, duration_seconds: input.durationSeconds, language, topic: input.topic, style: input.style };
  if (input.mode === "avatar" && input.avatarNarrationSource !== "tts") {
    // Avatar with own text or audio: no script call; the next paid step is the voice (text) or the avatar.
    const seconds = stats ? Math.max(1, Math.ceil(stats.estimate.max)) : input.durationSeconds;
    return { inputError, fit, stats, draft: null, stage: "before_render",
      request: { ...base, duration_seconds: seconds,
        recorded_audio_path: input.avatarNarrationSource === "recording" ? "form-upload" : null,
        script_json: { segments: [{ text: stats?.text || "—" }] } } };
  }
  return { inputError, fit, stats, draft, stage: "before_script", request: { ...base, recorded_audio_path: null, script_json: draft } };
}
