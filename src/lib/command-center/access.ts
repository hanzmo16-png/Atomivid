/**
 * Command Center access: OWNER/ADMIN only. Reuses the existing single-owner gate
 * (AVATAR_PREPARATION_OWNER_EMAIL, already configured) and allows an explicit, additional
 * allowlist COMMAND_CENTER_ADMIN_EMAILS (comma separated). Empty configuration denies everyone.
 * A confirmed e-mail is required; no new role system, no schema change.
 */
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";

export type AuthUser = { id?: string; email?: string; email_confirmed_at?: string } | null;

export function isCommandCenterAdmin(user: AuthUser, env: Record<string, string | undefined> = process.env): boolean {
  if (!user?.email || !user.email_confirmed_at) return false;
  if (canPrepareAvatar(user, env.AVATAR_PREPARATION_OWNER_EMAIL, env)) return true;
  const extra = (env.COMMAND_CENTER_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return extra.includes(user.email.toLowerCase());
}

export class CommandCenterAccessError extends Error { readonly status: 401 | 403; constructor(status: 401 | 403, message: string) { super(message); this.status = status; } }

export function requireCommandCenterAdmin(user: AuthUser, env: Record<string, string | undefined> = process.env): void {
  if (!user) throw new CommandCenterAccessError(401, "unauthenticated");
  if (!isCommandCenterAdmin(user, env)) throw new CommandCenterAccessError(403, "command center is owner/admin only");
}
