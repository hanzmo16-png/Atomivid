/**
 * Podcast 2.x ↔ pi_spend_authorizations (PR #198, proposal supabase/proposals/20261024000000_spend_authorizations.sql).
 *
 * Integration blocker found in the audiovisual closure audit: once that proposal is applied, pi_submit_with_supply
 * REFUSES every paid call of a 'podcast-<episode>' project without a stored ACTIVE authorization, but the app never
 * opened one, so every narration/production would stop at the first chunk ("authorization missing").
 *
 * Here the owner's explicit approval (the run limit / estimate shown on the page, the same amount the app already
 * enforces) is recorded through pi_open_spend_authorization BEFORE the job is dispatched. No bypass: the DB still
 * decides every call (owner from the episode row, cap immutable, FOR UPDATE lock). If the function does not exist
 * (proposal not applied) the DB does not require it and nothing changes. Any other refusal stops the request.
 */
export type RpcClient = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> };
export const SPEND_AUTHORIZATION_MAX_USD = 100;
export type OpenOutcome =
  | { ok: true; state: "opened" | "already_open" | "not_installed" | "nothing_to_pay"; capUsd: number | null }
  | { ok: false; status: number; error: string };

const notInstalled = (e: { code?: string; message?: string }) =>
  e.code === "PGRST202" || e.code === "42883" || /could not find the function|function .*pi_open_spend_authorization.* does not exist/i.test(e.message ?? "");

/** Cap = what the owner approved for this run, rounded UP to cents (never more than the DB maximum). */
export function authorizationCapUsd(approvedUsd: number | null | undefined): number | null {
  if (approvedUsd == null || !Number.isFinite(approvedUsd) || approvedUsd <= 0) return null;
  return Math.min(SPEND_AUTHORIZATION_MAX_USD, Math.ceil(approvedUsd * 100 - 1e-9) / 100);
}

export async function ensurePodcastSpendAuthorization(db: RpcClient, episodeId: string, approvedUsd: number | null | undefined, ref: string): Promise<OpenOutcome> {
  const cap = authorizationCapUsd(approvedUsd);
  if (cap == null) return { ok: true, state: "nothing_to_pay", capUsd: null };
  const { data, error } = await db.rpc("pi_open_spend_authorization", { p_episode_id: episodeId, p_cap_usd: cap, p_authorization_ref: ref });
  if (error) return notInstalled(error) ? { ok: true, state: "not_installed", capUsd: null }
    : { ok: false, status: 503, error: "No se pudo registrar la autorización de gasto; no se inicia nada para no cobrar sin autorización." };
  const r = (data ?? {}) as { opened?: boolean; reason?: string; capUsd?: number };
  if (r.opened === true) return { ok: true, state: "opened", capUsd: cap };
  // One immutable authorization per episode: an existing one keeps governing (the DB enforces its cap and status).
  if (r.reason === "already_open") return { ok: true, state: "already_open", capUsd: null };
  if (r.reason === "uncertain operations must be reconciled first") return { ok: false, status: 409, error: "Hay cobros inciertos pendientes de conciliar; no se autoriza gasto nuevo hasta resolverlos. No se cobró nada." };
  return { ok: false, status: 409, error: `La autorización de gasto fue rechazada (${String(r.reason ?? "motivo desconocido").slice(0, 80)}). No se cobró nada.` };
}
