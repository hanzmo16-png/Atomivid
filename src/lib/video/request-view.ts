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
