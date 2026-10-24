/**
 * Podcast 2.x ↔ pi_spend_authorizations (PR #198, applied: supabase/proposals/20261024000000_spend_authorizations.sql).
 *
 * pi_submit_with_supply REFUSES every paid call of a 'podcast-<episode>' project without a stored ACTIVE authorization,
 * so the owner's approval is recorded through pi_open_spend_authorization BEFORE the job is dispatched. FAIL CLOSED
 * (audit #200, Claude P0-2): any RPC error — including a missing function / schema-cache miss — or no answer within
 * the timeout returns 503 and nothing is dispatched. An existing (immutable) authorization is accepted only if it is
 * ACTIVE and its remaining amount covers what THIS run needs (audit P1-1); otherwise 409 before dispatch.
 * The DB keeps the final word on every call (owner from the episode row, FOR UPDATE lock).
 */
export type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
export type RpcClient = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult> };
export const SPEND_AUTHORIZATION_MAX_USD = 100;
export const SPEND_AUTHORIZATION_RPC_TIMEOUT_MS = 8000;
export type OpenOutcome =
  | { ok: true; state: "opened" | "already_open" | "nothing_to_pay"; capUsd: number | null; remainingUsd?: number }
  | { ok: false; status: number; error: string; reason?: string };

const UNAVAILABLE = "No se pudo registrar la autorización de gasto; no se inicia nada para no cobrar sin autorización.";
const unavailable = (reason: string): OpenOutcome => ({ ok: false, status: 503, error: UNAVAILABLE, reason });

/** Cap = what the owner approved, rounded UP to cents (never more than the DB maximum). */
export function authorizationCapUsd(approvedUsd: number | null | undefined): number | null {
  if (approvedUsd == null || !Number.isFinite(approvedUsd) || approvedUsd <= 0) return null;
  return Math.min(SPEND_AUTHORIZATION_MAX_USD, Math.ceil(approvedUsd * 100 - 1e-9) / 100);
}

async function call(db: RpcClient, fn: string, args: Record<string, unknown>, timeoutMs: number): Promise<RpcResult | "timeout" | "threw"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(db.rpc(fn, args)), new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), timeoutMs); })]);
  } catch { return "threw"; } finally { if (timer) clearTimeout(timer); }
}

/**
 * @param capUsd    what the owner approved for the EPISODE authorization (opened once, immutable).
 * @param neededUsd what THIS run may spend (must fit in the remaining amount of an existing authorization).
 */
export async function ensurePodcastSpendAuthorization(db: RpcClient, episodeId: string, capUsd: number | null | undefined, ref: string,
  opts: { neededUsd?: number | null; timeoutMs?: number } = {}): Promise<OpenOutcome> {
  const needed = opts.neededUsd ?? capUsd;
  const cap = authorizationCapUsd(Math.max(Number(capUsd) || 0, Number(needed) || 0));
  if (cap == null) return { ok: true, state: "nothing_to_pay", capUsd: null };
  const timeoutMs = opts.timeoutMs ?? SPEND_AUTHORIZATION_RPC_TIMEOUT_MS;
  const res = await call(db, "pi_open_spend_authorization", { p_episode_id: episodeId, p_cap_usd: cap, p_authorization_ref: ref }, timeoutMs);
  if (res === "timeout" || res === "threw") return unavailable(res);
  if (res.error) return unavailable(res.error.code || "rpc_error");
  const r = (res.data ?? {}) as { opened?: boolean; reason?: string };
  if (r.opened === true) return { ok: true, state: "opened", capUsd: cap };
  if (r.reason === "already_open") {
    const u = await call(db, "pi_spend_authorization_usage", { p_project_id: `podcast-${episodeId}`, p_exclude_key: null }, timeoutMs);
    if (u === "timeout" || u === "threw") return unavailable(`usage_${u}`);
    if (u.error || !u.data) return unavailable(u.error?.code || "usage_unreadable");
    const usage = u.data as { status?: string; remainingUsd?: number | string; capUsd?: number | string };
    const remaining = Number(usage.remainingUsd);
    if (usage.status !== "ACTIVE") return { ok: false, status: 409, reason: "authorization closed", error: "La autorización de gasto de este episodio está cerrada. No se cobró nada." };
    if (!Number.isFinite(remaining) || remaining + 1e-9 < (Number(needed) || 0)) return { ok: false, status: 409, reason: "authorization insufficient",
      error: `La autorización de gasto de este episodio (USD ${Number(usage.capUsd).toFixed(2)}) solo tiene USD ${Number.isFinite(remaining) ? remaining.toFixed(2) : "?"} disponibles y esta ejecución puede costar hasta USD ${(Number(needed) || 0).toFixed(2)}. No se inicia nada y no se cobró nada.` };
    return { ok: true, state: "already_open", capUsd: Number(usage.capUsd), remainingUsd: remaining };
  }
  if (r.reason === "uncertain operations must be reconciled first") return { ok: false, status: 409, reason: r.reason, error: "Hay cobros inciertos pendientes de conciliar; no se autoriza gasto nuevo hasta resolverlos. No se cobró nada." };
  return { ok: false, status: 409, reason: r.reason, error: `La autorización de gasto fue rechazada (${String(r.reason ?? "motivo desconocido").slice(0, 80)}). No se cobró nada.` };
}
