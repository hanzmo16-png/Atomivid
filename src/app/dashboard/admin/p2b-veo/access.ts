import { canPrepareAvatar } from "@/lib/video/avatar/private-access";

/**
 * Reutiliza EXACTAMENTE el mismo check de cuenta única ya usado por la
 * prueba privada de avatar (`canPrepareAvatar`, mismo env var
 * `AVATAR_PREPARATION_OWNER_EMAIL`, ya configurado en Vercel para la
 * cuenta de Hans) — cero configuración nueva necesaria en Vercel y
 * ningún sistema de roles/login nuevo. Nombrado aparte (no se modifica
 * private-access.ts, que sigue siendo específico de Avatar) solo para que
 * el gate de esta página administrativa se lea con su propio nombre.
 */
export function isP2BAdmin(user: Parameters<typeof canPrepareAvatar>[0]): boolean {
  return canPrepareAvatar(user);
}
