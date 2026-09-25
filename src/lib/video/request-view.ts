import type { BadgeTone } from "@/components/ui/Badge";

/**
 * Forma mínima de una solicitud tal como la necesita la UI (historial,
 * tarjeta, pantalla de resultado dedicada, y los estados de desarrollo en
 * /dev/states — un solo tipo para que los tres nunca se desincronicen).
 */
export type VideoRequestSummary = {
  id: string;
  mode?: string;
  topic: string;
  style: string;
  duration_seconds: number;
  language: string | null;
  status: string;
  video_path: string | null;
  error_message: string | null;
  script_json: unknown;
  progress_stage: string | null;
  render_attempts: number;
  render_started_at: string | null;
  created_at: string;
  /**
   * "9:16" (default histórico, Reel/Avatar) o "16:9" (Long Form) — columna
   * aditiva de la migración 0016. Opcional porque las páginas de desarrollo
   * (/dev/states) y filas más viejas pueden omitirla; ausente se trata
   * igual que "9:16" (comportamiento anterior sin cambios).
   */
  aspect_ratio?: string | null;
  /**
   * Progreso propio de Long Form (migración 0016) — nunca se lee
   * progress_stage para mode="long_form" (esa columna solo actúa como
   * cerrojo interno de concurrencia para esa modalidad, ver run-job.ts).
   */
  long_form_stage?: string | null;
  /**
   * Progreso real por-unidades dentro de la etapa actual (migración
   * 0019) — JSONB crudo, validado con isLongFormProgress() antes de
   * usarse (ver ProductionProgressCard.tsx). Ausente/null en filas
   * anteriores a esta migración o antes de la primera actualización de
   * progreso — se trata como "sin evidencia todavía", nunca como 0% falso.
   */
  long_form_progress?: unknown;
  /** Confirmación humana del plan de producción (migración 0019) — sin ella, Long Form nunca produce. */
  long_form_confirmed_at?: string | null;
  /**
   * Presente solo para avatar con narración propia/grabada (own_audio) o
   * "Voz IA desde texto" (tts) — ver dashboard/new/actions.ts. Copy fix
   * (RC QA 2026-09-25): el CTA de Historial decía "Revisar guion" incluso
   * cuando la solicitud en realidad abre "Revisar grabación"
   * (review/[id]/page.tsx ya distinguía esto por este mismo campo) — ver
   * RequestCard.tsx.
   */
  recorded_audio_path?: string | null;
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  script_ready: "Guion listo",
  processing: "Generando",
  completed: "Listo",
  failed: "Error",
};

export const STATUS_TONE: Record<string, BadgeTone> = {
  pending: "warning",
  script_ready: "accent",
  processing: "info",
  completed: "success",
  failed: "danger",
};

export const LANGUAGE_LABEL: Record<string, string> = {
  es: "Español",
  en: "English",
};

/**
 * CTA de "Generar guion" para una solicitud en estado pending — el mismo
 * texto/endpoint/redirect que ve el usuario en RequestCard, centralizado
 * aquí para poder fijarlo con un test de regresión puro (este proyecto no
 * tiene framework de testing de componentes). Es exactamente la
 * comprobación que faltaba en el blocker real de QA (2026-09-25): una
 * solicitud recién creada en pending debe llegar al Historial Y mostrar
 * este CTA, no solo "aparecer en la lista".
 */
export function pendingRequestCta(requestId: string): {
  label: string;
  endpoint: string;
  redirectTo: string;
} {
  return {
    label: "Generar guion",
    endpoint: `/api/generate/${requestId}/script`,
    redirectTo: `/dashboard/review/${requestId}`,
  };
}
