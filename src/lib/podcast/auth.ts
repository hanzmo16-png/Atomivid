import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { studioBetaUser } from "@/lib/podcast/v3/studio";

type PodcastAuthUser = { id: string; email: string | null; email_confirmed_at: string | null };

/** Podcast is a paid-capable private beta: same access list as Long Form. */
export async function podcastUser(): Promise<PodcastAuthUser | { error: string; status: number }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado", status: 401 };
  if (!canAccessLongFormBeta(user)) return { error: "El podcast no está disponible para tu cuenta.", status: 403 };
  return { id: user.id, email: user.email ?? null, email_confirmed_at: user.email_confirmed_at ?? null };
}

/**
 * Podcast Studio (API v3 y biblioteca): el dueño como hasta ahora, o un cliente de la beta (PODCAST_STUDIO_BETA_USER_IDS).
 * `beta` = cuenta de cliente: su gasto pasa por el derecho del plan (entitlement.ts). El podcast clásico sigue en podcastUser.
 */
export async function studioUser(): Promise<(PodcastAuthUser & { beta: boolean }) | { error: string; status: number }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado", status: 401 };
  const owner = canAccessLongFormBeta(user);
  if (!owner && !studioBetaUser(user)) return { error: "El podcast no está disponible para tu cuenta.", status: 403 };
  return { id: user.id, email: user.email ?? null, email_confirmed_at: user.email_confirmed_at ?? null, beta: !owner };
}
