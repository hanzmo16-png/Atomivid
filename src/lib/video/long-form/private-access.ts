import { canPrepareAvatar } from "@/lib/video/avatar/private-access";

/**
 * RC mission Fase 4: Long Form pasa de infraestructura/admin a producto
 * beta self-service, pero sigue siendo beta/admin-only (mission sección
 * 20 — "cuando Long Form real esté validado end-to-end desde la UI
 * normal, habilítalo SOLO para beta/admin primero, nunca lo abras a todos
 * los usuarios antes de terminar QA"). Reutiliza el MISMO gate de un solo
 * dueño ya usado por Avatar y por /dashboard/admin/p2b-veo (mismo patrón
 * que isP2BAdmin) — nunca se inventa un mecanismo nuevo de "quién es
 * admin", ni una variable de entorno nueva que Hans tendría que configurar
 * aparte.
 */
export function canAccessLongFormBeta(user: { email?: string; email_confirmed_at?: string } | null): boolean {
  return canPrepareAvatar(user);
}
