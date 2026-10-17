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
 * Legacy worker decision (kept for the T-30 preflight matrix; run-job.ts now uses `decideDirectorRender`, T-34 B3):
 * decides whether this render uses the Director. The owner account is only looked up when the
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

/** Why a render that REQUESTED the Director cannot apply it in the worker (T-34 B3). Fixed codes, no values. */
export type DirectorUnavailableReason = "not_eligible_reel" | "worker_switch_off" | "owner_lookup_failed" | "account_not_enabled" | "material_license_not_cleared";
const UNAVAILABLE_ACTION: Record<DirectorUnavailableReason, string> = {
  not_eligible_reel: "El Director solo dirige Reels visuales sin narración grabada. Qué hacer: genera este video desde un Reel visual o pide soporte.",
  worker_switch_off: "El servidor de render tiene el Director apagado aunque la web lo ofrecía. Qué hacer: el administrador debe encender el Director también en el servidor de render (misma configuración que la web) antes de reintentar.",
  owner_lookup_failed: "El servidor de render no pudo comprobar tu cuenta. Qué hacer: reintenta en unos minutos; si se repite, pide soporte.",
  account_not_enabled: "Tu cuenta no está habilitada para el Director en el servidor de render (lista del piloto o correo sin confirmar). Qué hacer: el administrador debe incluir la misma cuenta en el servidor de render, o confirma tu correo, y luego reintenta.",
  material_license_not_cleared: "El proveedor de material visual configurado en el servidor de render no tiene una licencia revisada para el Director. Qué hacer: el administrador debe usar un proveedor con licencia revisada (o revisarla) antes de reintentar.",
};
export class DirectorUnavailableError extends Error {
  readonly customerMessage: string;
  constructor(readonly reason: DirectorUnavailableReason) {
    const message = `Pediste el Director para este Reel, pero no se puede aplicar. No se reservó ni se cobró nada y no se hizo un montaje clásico en su lugar. ${UNAVAILABLE_ACTION[reason]}`;
    super(message);
    this.name = "DirectorUnavailableError";
    this.customerMessage = message;
  }
}

/**
 * Worker decision (T-34 B3), taken BEFORE any reservation or paid call. The web stores on the attempt whether it
 * requested the Director (`director_requested`, same rule as the review page); the worker never upgrades a request
 * that did not ask for it, and never downgrades one that did: requested but not applicable here ⇒ a typed,
 * customer-safe block instead of a silent classic montage. Long Form and Avatar never use this path.
 */
export async function decideDirectorRender(
  request: DirectorPilotRequest & { director_requested?: boolean | null },
  loadOwner: () => Promise<DirectorPilotUser>,
  env: Env = process.env,
): Promise<boolean> {
  if (request.director_requested !== true || (request.mode ?? "visual") !== "visual") return false;
  if (!directorPilotReel(request)) throw new DirectorUnavailableError("not_eligible_reel");
  if (!cinematicDirectorRenderEnabled(env)) throw new DirectorUnavailableError("worker_switch_off");
  let owner: DirectorPilotUser;
  try {
    owner = await loadOwner();
  } catch {
    throw new DirectorUnavailableError("owner_lookup_failed");
  }
  if (!directorPilotAccount(owner, env)) throw new DirectorUnavailableError("account_not_enabled");
  return true;
}
