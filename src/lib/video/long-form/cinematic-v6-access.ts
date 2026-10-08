/**
 * Activación de Cinematic V6 (plan v6). Falla cerrada:
 *   - CINEMATIC_V6_ENABLED_EMAILS: correos confirmados con V6 (fase propietario).
 *   - CINEMATIC_V6_ALL_USERS=true: activación global (preparada; NO se configura hasta que el propietario apruebe los vídeos reales).
 * El resto de cuentas sigue en el plan por defecto del producto (v3), sin ningún cambio.
 */
export type CinematicUser = { email?: string | null; email_confirmed_at?: string | null } | null | undefined;

export function cinematicV6Enabled(user: CinematicUser, env: Record<string, string | undefined> = process.env): boolean {
  if (!user?.email || !user.email_confirmed_at) return false;
  if (env.CINEMATIC_V6_ALL_USERS?.trim().toLowerCase() === "true") return true;
  const allowed = (env.CINEMATIC_V6_ENABLED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(user.email.trim().toLowerCase());
}

export class CinematicV6AccessError extends Error {}

/**
 * Worker (run-job.ts): un plan con secuencias (v5+) solo se ejecuta si la cuenta DUEÑA del
 * trabajo sigue habilitada AHORA. Falla cerrado: sin usuario, sin email confirmado, error de
 * consulta o cuenta fuera de la lista → no se ejecuta nada pagado. v1–v4 no consultan nada.
 */
export async function assertCinematicV6Account(
  plan: { version: number } | null,
  loadUser: () => Promise<CinematicUser>,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!plan || plan.version < 5) return;
  let user: CinematicUser;
  try {
    user = await loadUser();
  } catch {
    user = null;
  }
  if (!cinematicV6Enabled(user, env)) {
    throw new CinematicV6AccessError("Este plan Cinematic V6 no está habilitado para esta cuenta. No se ejecutó ninguna llamada pagada.");
  }
}
