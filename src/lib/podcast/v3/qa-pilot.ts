import { isBetaQaUser } from "@/lib/video/long-form/private-access";

/** Existing QA allowlist only: exactly one confirmed account, never an owner grant.
 * Multiple/malformed entries fail closed instead of broadening this pilot.
 */
export function studioQaPilot(user: { id?: string; email_confirmed_at?: string | null } | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (env.PODCAST_V3_QA_PILOT === "0") return false;
  const entries = (env.BETA_QA_USER_IDS ?? "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (!entries.length || entries.some(id => !uuid.test(id)) || new Set(entries).size !== 1) return false;
  return isBetaQaUser(user ? { id: user.id, email_confirmed_at: user.email_confirmed_at ?? undefined } : null, env);
}
