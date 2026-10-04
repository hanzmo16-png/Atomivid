import { canPrepareAvatar } from "../../video/avatar/private-access";
export function directorActor(user: { id: string; email?: string; email_confirmed_at?: string } | null, env: Record<string, string | undefined> = process.env): string {
  const enabled = env.VFX_DIRECTOR_ENABLED ?? (env.VERCEL_ENV === "preview" ? "1" : "0");
  if (enabled !== "1" || !user || !canPrepareAvatar(user, env.VFX_DIRECTOR_OWNER_EMAIL ?? env.AVATAR_PREPARATION_OWNER_EMAIL)) throw new Error("VFX_OWNER_ONLY");
  return user.id;
}
