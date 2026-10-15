import { cinematicDirectorRenderEnabled, cinematicDirectorV2Enabled } from "./flag";

/**
 * Pilot access to the Director (chatgpt-06). Fail-closed and decided only from trusted server/worker configuration:
 *   - CINEMATIC_DIRECTOR_RENDER_ENABLED / CINEMATIC_DIRECTOR_V2_ENABLED: the existing global switches (off by default).
 *   - CINEMATIC_DIRECTOR_PILOT_EMAILS: comma-separated confirmed emails allowed to use them. Empty = nobody.
 * Only a visual Reel (no avatar, no Long Form, no recorded narration) owned by a confirmed account on the list
 * qualifies. Nothing sent by the browser or in the dispatch payload can turn it on: the worker re-reads the
 * request row and the owner account itself.
 */
export type DirectorPilotUser = { email?: string | null; email_confirmed_at?: string | null } | null | undefined;
export type DirectorPilotRequest = { mode?: string | null; recorded_audio_path?: string | null };
type Env = Record<string, string | undefined>;

export function directorPilotAccount(user: DirectorPilotUser, env: Env = process.env): boolean {
  if (!user?.email || !user.email_confirmed_at) return false;
  const allowed = (env.CINEMATIC_DIRECTOR_PILOT_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(user.email.trim().toLowerCase());
}

export function directorPilotReel(request: DirectorPilotRequest): boolean {
  return (request.mode ?? "visual") === "visual" && !request.recorded_audio_path;
}

/** Review page (Vercel): read-only inspection panel. */
export function directorInspectionAllowed(user: DirectorPilotUser, request: DirectorPilotRequest, env: Env = process.env): boolean {
  return cinematicDirectorV2Enabled(env) && directorPilotReel(request) && directorPilotAccount(user, env);
}

/** Whether the render would use the Director for this user/request (also shown in the inspection panel). */
export function directorRenderAllowed(user: DirectorPilotUser, request: DirectorPilotRequest, env: Env = process.env): boolean {
  return cinematicDirectorRenderEnabled(env) && directorPilotReel(request) && directorPilotAccount(user, env);
}

/**
 * Worker (run-job.ts): decides whether this render uses the Director. The owner account is only looked up when the
 * global switch is on and the request is a visual Reel; a failed lookup keeps the previous (classic) montage.
 */
export async function resolveDirectorRender(
  request: DirectorPilotRequest,
  loadOwner: () => Promise<DirectorPilotUser>,
  env: Env = process.env,
): Promise<boolean> {
  if (!cinematicDirectorRenderEnabled(env) || !directorPilotReel(request)) return false;
  let owner: DirectorPilotUser;
  try {
    owner = await loadOwner();
  } catch {
    owner = null;
  }
  return directorRenderAllowed(owner, request, env);
}
