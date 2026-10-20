import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";

/** Podcast is a paid-capable private beta: same access list as Long Form. */
export async function podcastUser(): Promise<{ id: string; email: string | null; email_confirmed_at: string | null } | { error: string; status: number }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado", status: 401 };
  if (!canAccessLongFormBeta(user)) return { error: "El podcast no está disponible para tu cuenta.", status: 403 };
  return { id: user.id, email: user.email ?? null, email_confirmed_at: user.email_confirmed_at ?? null };
}
