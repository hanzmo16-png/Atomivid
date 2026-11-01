/**
 * DURABLE STUDIO-SCRIPT AUTHORIZATION — DESIGN, NOT APPLIED.
 *
 * Migration (do not apply in this PR):
 *   supabase/proposals/20261101152000_studio_script_spend_authorization.sql
 * Design: docs/STUDIO_SCRIPT_SPEND_AUTHORIZATION.md
 *
 * PODCAST_STUDIO_SCRIPT_DURABLE_AUTH must stay unset until that proposal is applied.
 *   flag off (production tip): daily cap + global/provider caps. This module is not called.
 *   flag on, migration absent: fail closed (503). No Anthropic call.
 *   migration applied, flag off: pi_submit_with_supply fail-closes studio-script:% anyway.
 *
 * The database stamps transaction_id (txid_current of the OPEN). The app cannot invent the
 * triple. Submit receives only the ledger key; the wrapper copies project_id + authorization_ref
 * + transaction_id onto pi_studio_script_spend_grants.
 */
import type { RpcClient } from "@/lib/podcast/spend-authorization-open";
import { SPEND_AUTHORIZATION_RPC_TIMEOUT_MS } from "@/lib/podcast/spend-authorization-open";

/** Same clamp as scriptDailyCapUsd (api.ts). Kept here so this module does not import the route logic. */
function dailyCapUsd(env: Record<string, string | undefined>): number {
  const v = Number(env.PODCAST_SCRIPT_DAILY_USD);
  return Number.isFinite(v) && v > 0 ? Math.min(50, Math.max(0.5, v)) : 3;
}

export const STUDIO_SCRIPT_PROJECT_PREFIX = "studio-script:";
export const STUDIO_SCRIPT_DURABLE_AUTH_ENV = "PODCAST_STUDIO_SCRIPT_DURABLE_AUTH";
/** Operator ceiling for ONE script job. Default is the daily cap. Never taken from the browser. */
export const STUDIO_SCRIPT_JOB_USD_ENV = "PODCAST_SCRIPT_JOB_USD";
export const STUDIO_SCRIPT_AUTH_TTL_HOURS = 24;
/** Preflight floor before a step. The database compares the real reserved_usd. */
export const STUDIO_SCRIPT_STEP_HOLD_USD = 0.05;
export const STUDIO_SCRIPT_AUTH_MAX_USD = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Same shape as adapters.studioScriptProject. Episode gate stays podcast- / documentary: only. */
export const studioScriptProject = (ownerId: string, jobId: string) => `${STUDIO_SCRIPT_PROJECT_PREFIX}${ownerId}:${jobId}`;
export const studioScriptAuthorizationRef = (jobId: string) => `studio-script-auth:${jobId}`;
export const isStudioScriptUuid = (id: string) => UUID.test(id);

/** Exact "1". Anything else, including "true" or empty, keeps the lesser contract. */
export function studioScriptDurableAuthEnabled(env: Record<string, string | undefined>): boolean {
  return env[STUDIO_SCRIPT_DURABLE_AUTH_ENV] === "1";
}

/** Per-job ceiling. Unset PODCAST_SCRIPT_JOB_USD → the daily cap (default USD 3). Clamped to (0.5, 50]. */
export function scriptJobAuthorizationCapUsd(env: Record<string, string | undefined>): number {
  const raw = Number(env[STUDIO_SCRIPT_JOB_USD_ENV]);
  const chosen = Number.isFinite(raw) && raw > 0 ? raw : dailyCapUsd(env);
  return Math.min(STUDIO_SCRIPT_AUTH_MAX_USD, Math.max(0.5, chosen));
}

export type StudioScriptOp = {
  idempotencyKey: string;
  projectId: string;
  status: string;
  reservedUsd: number;
  committedUsd?: number | null;
  method?: string;
  supplyReconciled?: boolean;
};

const PENDING = new Set(["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"]);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Same arithmetic as pi_studio_script_authorization_usage (and pi_spend_authorization_usage):
 * COMMITTED at actual cost, open reservations, and unreconciled REFUNDED. capacity_hold and
 * baseline keys are excluded. RESERVED does not count until it is submitted.
 */
export function studioScriptUsage(capUsd: number, ops: readonly StudioScriptOp[], projectId: string, excludeKey?: string, baselineKeys: readonly string[] = []) {
  const base = new Set(baselineKeys);
  let committedUsd = 0, pendingUsd = 0;
  for (const o of ops) {
    if (o.projectId !== projectId || o.idempotencyKey === excludeKey || base.has(o.idempotencyKey) || o.method === "capacity_hold") continue;
    if (o.status === "COMMITTED") committedUsd += Number(o.committedUsd ?? o.reservedUsd) || 0;
    else if (PENDING.has(o.status) || (o.status === "REFUNDED" && o.supplyReconciled !== true)) pendingUsd += Number(o.reservedUsd) || 0;
  }
  return { capUsd, committedUsd: r4(committedUsd), pendingUsd: r4(pendingUsd), remainingUsd: r4(capUsd - committedUsd - pendingUsd) };
}

export type StudioScriptAuthRow = {
  projectId: string;
  ownerId: string;
  jobId: string;
  capUsd: number;
  authorizationRef: string;
  transactionId: string;
  status: "ACTIVE" | "CLOSED" | "EXPIRED" | "BOUND";
  expiresAt: string;
  baselineKeys?: readonly string[];
};

export type StudioScriptDecision =
  | { admit: true; triple: { projectId: string; authorizationRef: string; transactionId: string } }
  | { admit: false; reason: "authorization missing" | "authorization closed" | "authorization expired" | "authorization owner mismatch" | "authorization exceeded" | "authorization cost unverified" };

/**
 * Executable spec of the studio-script branch inside pi_submit_with_supply.
 * The database is the authority; this function is what the unit tests lock to the SQL reason strings.
 */
export function decideStudioScriptSubmit(input: {
  projectId: string;
  reservedUsd: number;
  now: string;
  auth: StudioScriptAuthRow | null;
  ops: readonly StudioScriptOp[];
  excludeKey: string;
}): StudioScriptDecision {
  if (!input.projectId.startsWith(STUDIO_SCRIPT_PROJECT_PREFIX)) {
    throw new Error("decideStudioScriptSubmit is only for studio-script projects");
  }
  if (!isCanonicalStudioScriptProject(input.projectId)) return { admit: false, reason: "authorization owner mismatch" };
  const auth = input.auth;
  if (!auth) return { admit: false, reason: "authorization missing" };
  const canonical = studioScriptProject(auth.ownerId, auth.jobId);
  const tripleOk = canonical === input.projectId && canonical === auth.projectId
    && isStudioScriptUuid(auth.ownerId) && isStudioScriptUuid(auth.jobId)
    && auth.authorizationRef.trim().length > 0 && /^[1-9][0-9]*$/.test(auth.transactionId);
  if (!tripleOk) return { admit: false, reason: "authorization owner mismatch" };
  if (auth.status === "EXPIRED" || (auth.status === "ACTIVE" && Date.parse(auth.expiresAt) <= Date.parse(input.now))) {
    return { admit: false, reason: "authorization expired" };
  }
  if (auth.status !== "ACTIVE") return { admit: false, reason: "authorization closed" };
  if (!(Number.isFinite(input.reservedUsd) && input.reservedUsd > 0)) return { admit: false, reason: "authorization cost unverified" };
  const u = studioScriptUsage(auth.capUsd, input.ops, input.projectId, input.excludeKey, auth.baselineKeys);
  if (u.committedUsd + u.pendingUsd + input.reservedUsd > auth.capUsd + 1e-9) return { admit: false, reason: "authorization exceeded" };
  return { admit: true, triple: { projectId: auth.projectId, authorizationRef: auth.authorizationRef, transactionId: auth.transactionId } };
}

export function isCanonicalStudioScriptProject(projectId: string): boolean {
  const [prefix, owner, job] = projectId.split(":");
  return prefix === "studio-script" && !!owner && !!job && isStudioScriptUuid(owner) && isStudioScriptUuid(job)
    && projectId === studioScriptProject(owner, job);
}

export type StudioScriptAuthOutcome =
  | { ok: true; state: "opened" | "already_open"; projectId: string; authorizationRef: string; transactionId: string; capUsd: number; remainingUsd: number | null }
  | { ok: false; status: number; error: string; reason: string };

export type StudioScriptBindOutcome =
  | { ok: true; state: "bound" | "already_bound"; projectId: string; episodeId: string; authorizationRef: string; transactionId: string }
  | { ok: false; status: number; error: string; reason: string; episodeId?: string };

const UNAVAILABLE = "No se pudo registrar la autorización de gasto del guion; no se llamó a la IA. Lo ya escrito se conserva.";

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

async function call(db: RpcClient, fn: string, args: Record<string, unknown>, timeoutMs: number): Promise<RpcResult | "timeout" | "threw"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(db.rpc(fn, args)),
      new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), timeoutMs); }),
    ]);
  } catch { return "threw"; } finally { if (timer) clearTimeout(timer); }
}

function unavailable(reason: string): StudioScriptAuthOutcome {
  return { ok: false, status: 503, error: UNAVAILABLE, reason };
}

function refused(reason: string, error: string): StudioScriptAuthOutcome {
  return { ok: false, status: 409, error, reason };
}

type UsageRow = {
  status?: string; remainingUsd?: number | string; capUsd?: number | string;
  authorizationRef?: string; transactionId?: string | number; projectId?: string; expiresAt?: string;
};

function tripleFrom(row: UsageRow, fallbackProject: string): { projectId: string; authorizationRef: string; transactionId: string } | null {
  const authorizationRef = String(row.authorizationRef ?? "").trim();
  const transactionId = String(row.transactionId ?? "").trim();
  const projectId = String(row.projectId ?? fallbackProject);
  if (!authorizationRef || !/^[1-9][0-9]*$/.test(transactionId) || !isCanonicalStudioScriptProject(projectId)) return null;
  return { projectId, authorizationRef, transactionId };
}

/**
 * Opens (or re-reads) the job authorization. Cap and ref are server-side.
 * Fail closed on missing RPC, timeout, throw, or a row without a database transaction id.
 * MIGRATION MUST BE APPLIED before the flag that reaches this function is set.
 */
export async function ensureStudioScriptAuthorization(db: RpcClient, ownerId: string, jobId: string, env: Record<string, string | undefined>,
  opts: { neededUsd?: number; timeoutMs?: number } = {}): Promise<StudioScriptAuthOutcome> {
  if (!isStudioScriptUuid(ownerId) || !isStudioScriptUuid(jobId)) return { ok: false, status: 400, reason: "job invalid", error: "El identificador del guion no es válido. No se llamó a la IA." };
  const cap = scriptJobAuthorizationCapUsd(env);
  const needed = opts.neededUsd ?? STUDIO_SCRIPT_STEP_HOLD_USD;
  const timeoutMs = opts.timeoutMs ?? SPEND_AUTHORIZATION_RPC_TIMEOUT_MS;
  const projectId = studioScriptProject(ownerId, jobId);
  const res = await call(db, "pi_open_studio_script_authorization", {
    p_owner_id: ownerId, p_job_id: jobId, p_cap_usd: cap, p_authorization_ref: studioScriptAuthorizationRef(jobId), p_ttl_hours: STUDIO_SCRIPT_AUTH_TTL_HOURS,
  }, timeoutMs);
  if (res === "timeout" || res === "threw") return unavailable(res);
  if (res.error) return unavailable(res.error.code || "rpc_error");
  const r = (res.data ?? {}) as { opened?: boolean; reason?: string; projectId?: string; authorizationRef?: string; transactionId?: string | number; capUsd?: number | string; status?: string };
  if (r.opened === true) {
    const triple = tripleFrom(r, projectId);
    if (!triple) return unavailable("triple_missing");
    const usage = await readUsage(db, projectId, timeoutMs);
    if (!usage.ok) return usage.outcome;
    if (usage.row.status && usage.row.status !== "ACTIVE") return statusRefusal(usage.row.status);
    if (!fresh(usage.row.expiresAt)) return statusRefusal("EXPIRED");
    const remaining = Number(usage.row.remainingUsd);
    if (!Number.isFinite(remaining) || remaining + 1e-9 < needed) return insufficient(usage.row, needed);
    return { ok: true, state: "opened", ...triple, capUsd: Number(r.capUsd ?? cap), remainingUsd: remaining };
  }
  if (r.reason === "already_open") {
    const usage = await readUsage(db, projectId, timeoutMs);
    if (!usage.ok) return usage.outcome;
    const triple = tripleFrom(usage.row, projectId);
    if (!triple) return unavailable("triple_missing");
    if (usage.row.status !== "ACTIVE") return statusRefusal(String(usage.row.status ?? "unknown"));
    if (!fresh(usage.row.expiresAt)) return statusRefusal("EXPIRED");
    const remaining = Number(usage.row.remainingUsd);
    if (!Number.isFinite(remaining) || remaining + 1e-9 < needed) return insufficient(usage.row, needed);
    return { ok: true, state: "already_open", ...triple, capUsd: Number(usage.row.capUsd), remainingUsd: remaining };
  }
  if (r.reason === "uncertain operations must be reconciled first") {
    return refused(r.reason, "Hay cobros de este guion sin confirmar; no se autoriza otra llamada hasta resolverlos. No se llamó a la IA.");
  }
  return refused(String(r.reason ?? "rejected"), `La autorización de gasto del guion fue rechazada (${String(r.reason ?? "motivo desconocido").slice(0, 80)}). No se llamó a la IA.`);
}

const fresh = (expiresAt: string | undefined) => {
  const exp = Date.parse(String(expiresAt ?? ""));
  return Number.isFinite(exp) && exp > Date.now();
};

function statusRefusal(status: string): StudioScriptAuthOutcome {
  if (status === "EXPIRED") return refused("authorization expired", "La autorización de gasto de este guion venció. Lo ya escrito se conserva; empieza un guion nuevo. No se llamó a la IA.");
  return refused("authorization closed", "La autorización de gasto de este guion está cerrada. Lo ya escrito se conserva. No se llamó a la IA.");
}

function insufficient(row: UsageRow, needed: number): StudioScriptAuthOutcome {
  const remaining = Number(row.remainingUsd);
  return refused("authorization exceeded", `La autorización de este guion (USD ${Number(row.capUsd).toFixed(2)}) solo tiene USD ${Number.isFinite(remaining) ? remaining.toFixed(2) : "?"} disponibles y el siguiente paso necesita al menos USD ${needed.toFixed(2)}. No se llamó a la IA.`);
}

async function readUsage(db: RpcClient, projectId: string, timeoutMs: number): Promise<{ ok: true; row: UsageRow } | { ok: false; outcome: StudioScriptAuthOutcome }> {
  const u = await call(db, "pi_studio_script_authorization_usage", { p_project_id: projectId, p_exclude_key: null }, timeoutMs);
  if (u === "timeout" || u === "threw") return { ok: false, outcome: unavailable(`usage_${u}`) };
  if (u.error || !u.data) return { ok: false, outcome: unavailable(u.error?.code || "usage_unreadable") };
  return { ok: true, row: u.data as UsageRow };
}

const BIND_UNAVAILABLE = "No se pudo vincular la autorización del guion con el episodio; no se dejó el borrador. No se generó nada.";

/**
 * After the draft episode row exists. Fail closed: the caller deletes the draft if this returns ok: false.
 * MIGRATION MUST BE APPLIED (and podcast_studio_episodes must exist) before the flag is set.
 */
export async function bindStudioScriptAuthorization(db: RpcClient, ownerId: string, jobId: string, episodeId: string,
  opts: { timeoutMs?: number } = {}): Promise<StudioScriptBindOutcome> {
  if (!isStudioScriptUuid(ownerId) || !isStudioScriptUuid(jobId) || !isStudioScriptUuid(episodeId)) {
    return { ok: false, status: 400, reason: "job invalid", error: "El identificador del guion o del episodio no es válido. No se creó el episodio." };
  }
  const timeoutMs = opts.timeoutMs ?? SPEND_AUTHORIZATION_RPC_TIMEOUT_MS;
  const res = await call(db, "pi_bind_studio_script_authorization", { p_owner_id: ownerId, p_job_id: jobId, p_episode_id: episodeId }, timeoutMs);
  if (res === "timeout" || res === "threw") return { ok: false, status: 503, reason: res, error: BIND_UNAVAILABLE };
  if (res.error) return { ok: false, status: 503, reason: res.error.code || "rpc_error", error: BIND_UNAVAILABLE };
  const r = (res.data ?? {}) as { bound?: boolean; state?: string; reason?: string; projectId?: string; episodeId?: string; authorizationRef?: string; transactionId?: string | number };
  if (r.bound === true && (r.state === "bound" || r.state === "already_bound")) {
    const authorizationRef = String(r.authorizationRef ?? "").trim();
    const transactionId = String(r.transactionId ?? "").trim();
    const projectId = String(r.projectId ?? "");
    if (!authorizationRef || !/^[1-9][0-9]*$/.test(transactionId) || !isCanonicalStudioScriptProject(projectId)) {
      return { ok: false, status: 503, reason: "triple_missing", error: BIND_UNAVAILABLE };
    }
    return { ok: true, state: r.state, projectId, episodeId: String(r.episodeId ?? episodeId), authorizationRef, transactionId };
  }
  const reason = String(r.reason ?? "rejected");
  const status = reason === "studio episodes table missing" ? 503 : 409;
  return { ok: false, status, reason, episodeId: typeof r.episodeId === "string" ? r.episodeId : undefined,
    error: reason === "authorization owner mismatch" ? "Ese episodio no corresponde a la autorización del guion. No se creó el episodio."
      : reason === "job already bound" ? "Ese guion ya está vinculado a otro episodio. No se creó otro borrador."
      : reason === "episode not bindable" ? "Solo un borrador puede heredar la autorización del guion."
      : reason === "studio episodes table missing" ? "Falta la tabla del estudio; no se vinculó la autorización. No se dejó el borrador."
      : `No se pudo vincular la autorización del guion (${reason.slice(0, 80)}). No se dejó el borrador.` };
}
