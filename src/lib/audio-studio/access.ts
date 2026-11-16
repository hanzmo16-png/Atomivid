import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";

type U = { id?: string; email?: string; email_confirmed_at?: string } | null;

/**
 * Audio Podcast Studio usa la misma lista de acceso privada que Podcast y Long Form (beta + cuenta interna del
 * dueño). `AUDIO_STUDIO_DISABLED=1` apaga el módulo (ruta, API y enlace) sin desplegar código nuevo.
 */
export function canAccessAudioStudio(user: U, env: Record<string, string | undefined> = process.env): boolean {
  if (env.AUDIO_STUDIO_DISABLED === "1") return false;
  return !!user?.id && canAccessLongFormBeta(user);
}
