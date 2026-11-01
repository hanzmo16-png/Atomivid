/**
 * Durable studio-script authorization (DESIGN). USD 0: mocked RPC, no network, no migration apply.
 * The SQL proposal is reviewed by reading it and, on a disposable cluster, by scripts/qa/studio-script-auth-db.sh.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiresAuthorization } from "@/lib/supply/spend-authorization";
import { studioScriptProject as adapterProject } from "@/lib/podcast/v3/adapters";
import { scriptDailyCapUsd, studioAction, type ApiDeps } from "@/lib/podcast/v3/api";
import { StudioSpec, STUDIO_VERSION } from "@/lib/podcast/v3/spec";
import { scriptJobIdOf } from "@/lib/podcast/v3/wizard";
import type { AccountVoice } from "@/lib/podcast/voices";
import {
  bindStudioScriptAuthorization, decideStudioScriptSubmit, ensureStudioScriptAuthorization, isCanonicalStudioScriptProject,
  scriptJobAuthorizationCapUsd, studioScriptAuthorizationRef, studioScriptDurableAuthEnabled, studioScriptProject, studioScriptUsage,
  STUDIO_SCRIPT_STEP_HOLD_USD, type StudioScriptAuthRow, type StudioScriptOp,
} from "./studio-script-authorization";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const proposal = readFileSync(path.join(root, "supabase/proposals/20261101152000_studio_script_spend_authorization.sql"), "utf8");
const rollback = readFileSync(path.join(root, "supabase/proposals/20261101152000_studio_script_spend_authorization.rollback.sql"), "utf8");
const OWNER = "6b1c2d3e-0000-4000-8000-000000000001";
const JOB = "11111111-2222-4333-8444-555555555555";
const EP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PROJECT = studioScriptProject(OWNER, JOB);
const future = new Date(Date.now() + 3600_000).toISOString();
const AUTH = (over: Partial<StudioScriptAuthRow> = {}): StudioScriptAuthRow => ({
  projectId: PROJECT, ownerId: OWNER, jobId: JOB, capUsd: 3, authorizationRef: studioScriptAuthorizationRef(JOB),
  transactionId: "4242", status: "ACTIVE", expiresAt: future, ...over,
});

test("el archivo de diseño no está en supabase/migrations y dice NOT APPLIED", () => {
  const mig = readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.includes("studio_script_spend"));
  assert.deepEqual(mig, []);
  assert.match(proposal, /NOT APPLIED/);
  assert.match(proposal, /Do NOT run supabase db push/);
  assert.match(rollback, /Keeps the three studio-script tables/);
  for (const reason of ["authorization missing", "authorization closed", "authorization expired", "authorization owner mismatch", "authorization exceeded", "authorization cost unverified"]) {
    assert.match(proposal, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(proposal, /revoke all on table public\.pi_studio_script_authorizations from public, anon, authenticated, service_role/);
  assert.match(proposal, /revoke all on function public\.pi_submit_with_supply_pre_studio_script\(text, numeric\) from public, anon, authenticated, service_role/);
  assert.match(proposal, /txid_current\(\)/);
  assert.match(proposal, /studio-script:/);
  assert.doesNotMatch(proposal, /heygen|mp4/i);
});

test("studio-script no entra al gate de episodios; el id canónico coincide con el adaptador", () => {
  assert.equal(requiresAuthorization(PROJECT), false);
  assert.equal(requiresAuthorization("podcast-studio:x:y"), true);
  assert.equal(PROJECT, adapterProject(OWNER, JOB));
  assert.equal(isCanonicalStudioScriptProject(PROJECT), true);
  assert.equal(isCanonicalStudioScriptProject("studio-script:nope"), false);
  assert.equal(isCanonicalStudioScriptProject(`STUDIO-SCRIPT:${OWNER}:${JOB}`), false);
  assert.equal(studioScriptDurableAuthEnabled({}), false);
  assert.equal(studioScriptDurableAuthEnabled({ PODCAST_STUDIO_SCRIPT_DURABLE_AUTH: "true" }), false);
  assert.equal(studioScriptDurableAuthEnabled({ PODCAST_STUDIO_SCRIPT_DURABLE_AUTH: "1" }), true);
});

test("el tope del trabajo sale del operador, no del navegador, y no supera el tope del estudio", () => {
  assert.equal(scriptJobAuthorizationCapUsd({}), scriptDailyCapUsd({}));
  assert.equal(scriptJobAuthorizationCapUsd({ PODCAST_SCRIPT_DAILY_USD: "10" }), 10);
  assert.equal(scriptJobAuthorizationCapUsd({ PODCAST_SCRIPT_JOB_USD: "1.25" }), 1.25);
  assert.equal(scriptJobAuthorizationCapUsd({ PODCAST_SCRIPT_JOB_USD: "0.1" }), 0.5);
  assert.equal(scriptJobAuthorizationCapUsd({ PODCAST_SCRIPT_JOB_USD: "80" }), 50);
  assert.equal(studioScriptAuthorizationRef(JOB), `studio-script-auth:${JOB}`);
  assert.equal(scriptJobIdOf({ jobId: JOB }), JOB);
  assert.equal(scriptJobIdOf({ jobId: "NO-ES-UUID" }), null);
});

test("usage cuenta lo comprometido, lo pendiente y el reembolso sin conciliar; el baseline y capacity_hold no", () => {
  const ops: StudioScriptOp[] = [
    { idempotencyKey: "c", projectId: PROJECT, status: "COMMITTED", reservedUsd: 0.2, committedUsd: 0.17 },
    { idempotencyKey: "p", projectId: PROJECT, status: "SUBMITTED", reservedUsd: 0.05 },
    { idempotencyKey: "r", projectId: PROJECT, status: "REFUNDED", reservedUsd: 0.04, supplyReconciled: false },
    { idempotencyKey: "ok", projectId: PROJECT, status: "REFUNDED", reservedUsd: 9, supplyReconciled: true },
    { idempotencyKey: "hold", projectId: PROJECT, status: "SUBMITTED", reservedUsd: 9, method: "capacity_hold" },
    { idempotencyKey: "old", projectId: PROJECT, status: "COMMITTED", reservedUsd: 1, committedUsd: 1 },
    { idempotencyKey: "reserved", projectId: PROJECT, status: "RESERVED", reservedUsd: 2 },
  ];
  const u = studioScriptUsage(3, ops, PROJECT, "self", ["old"]);
  assert.equal(u.committedUsd, 0.17);
  assert.equal(u.pendingUsd, 0.09);
  assert.equal(u.remainingUsd, 2.74);
});

test("decideStudioScriptSubmit: falta, dueño, vencida, cerrada, costo, tope y triple", () => {
  const base = { projectId: PROJECT, reservedUsd: 0.1, now: new Date().toISOString(), ops: [], excludeKey: "k" };
  assert.equal(decideStudioScriptSubmit({ ...base, auth: null }).admit, false);
  assert.equal((decideStudioScriptSubmit({ ...base, projectId: "studio-script:NOPE", auth: null }) as { reason: string }).reason, "authorization owner mismatch");
  assert.equal((decideStudioScriptSubmit({ ...base, auth: AUTH({ ownerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", projectId: PROJECT }) }) as { reason: string }).reason, "authorization owner mismatch");
  assert.equal((decideStudioScriptSubmit({ ...base, auth: AUTH({ transactionId: "" }) }) as { reason: string }).reason, "authorization owner mismatch");
  assert.equal((decideStudioScriptSubmit({ ...base, auth: AUTH({ status: "EXPIRED" }) }) as { reason: string }).reason, "authorization expired");
  assert.equal((decideStudioScriptSubmit({ ...base, auth: AUTH({ expiresAt: new Date(Date.now() - 1000).toISOString() }) }) as { reason: string }).reason, "authorization expired");
  assert.equal((decideStudioScriptSubmit({ ...base, auth: AUTH({ status: "BOUND" }) }) as { reason: string }).reason, "authorization closed");
  assert.equal((decideStudioScriptSubmit({ ...base, auth: AUTH(), reservedUsd: 0 }) as { reason: string }).reason, "authorization cost unverified");
  const spent: StudioScriptOp[] = [{ idempotencyKey: "c", projectId: PROJECT, status: "COMMITTED", reservedUsd: 0.2, committedUsd: 2.96 }];
  assert.equal((decideStudioScriptSubmit({ ...base, auth: AUTH(), ops: spent }) as { reason: string }).reason, "authorization exceeded");
  const ok = decideStudioScriptSubmit({ ...base, auth: AUTH() });
  assert.equal(ok.admit, true);
  if (ok.admit) assert.deepEqual(ok.triple, { projectId: PROJECT, authorizationRef: studioScriptAuthorizationRef(JOB), transactionId: "4242" });
});

const usage = (over: Record<string, unknown> = {}) => ({ data: { status: "ACTIVE", capUsd: 3, remainingUsd: 2.5, authorizationRef: studioScriptAuthorizationRef(JOB), transactionId: "4242", projectId: PROJECT, expiresAt: future, ...over }, error: null });
const rpc = (open: { data?: unknown; error?: { code?: string; message?: string } | null } | "hang", read?: { data?: unknown; error?: { code?: string } | null }) => {
  const calls: string[] = [];
  return { calls, rpc(fn: string) {
    calls.push(fn);
    const out = fn === "pi_studio_script_authorization_usage" || fn === "pi_spend_authorization_usage" ? (read ?? usage()) : open;
    return out === "hang" ? new Promise<never>(() => {}) : Promise.resolve({ data: out.data ?? null, error: out.error ?? null });
  } };
};

function refusal<T extends { ok: boolean }>(x: T): Extract<T, { ok: false }> {
  if (x.ok) throw new Error("expected refusal");
  return x as Extract<T, { ok: false }>;
}

test("ensure: RPC ausente, timeout o triple vacío → 503 y no hay llamada que el test pueda confundir con un ok", async () => {
  assert.equal((await ensureStudioScriptAuthorization(rpc({ error: { code: "PGRST202" } }), OWNER, JOB, {})).ok, false);
  assert.equal(refusal(await ensureStudioScriptAuthorization(rpc({ error: { code: "42883" } }), OWNER, JOB, {})).status, 503);
  const hung = await Promise.race([
    ensureStudioScriptAuthorization(rpc("hang"), OWNER, JOB, {}, { timeoutMs: 30 }),
    new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 500)),
  ]);
  assert.notEqual(hung, "timeout");
  assert.equal((hung as { status: number }).status, 503);
  const bare = rpc({ data: { opened: true, projectId: PROJECT, capUsd: 3 } }, { data: { status: "ACTIVE", capUsd: 3, remainingUsd: 3, projectId: PROJECT, expiresAt: future } });
  assert.equal(refusal(await ensureStudioScriptAuthorization(bare, OWNER, JOB, {})).reason, "triple_missing");
});

test("ensure: abierta con saldo, ya abierta sin saldo, vencida, incierta", async () => {
  const open = rpc({ data: { opened: true, projectId: PROJECT, authorizationRef: studioScriptAuthorizationRef(JOB), transactionId: "99", capUsd: 3 } });
  const ok = await ensureStudioScriptAuthorization(open, OWNER, JOB, {});
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.transactionId, "99");
  assert.deepEqual(open.calls, ["pi_open_studio_script_authorization", "pi_studio_script_authorization_usage"]);
  const short = rpc({ data: { opened: false, reason: "already_open" } }, usage({ remainingUsd: STUDIO_SCRIPT_STEP_HOLD_USD / 2 }));
  const no = await ensureStudioScriptAuthorization(short, OWNER, JOB, {});
  assert.equal(no.ok, false);
  if (!no.ok) assert.equal(no.status, 409);
  const expired = rpc({ data: { opened: false, reason: "already_open" } }, usage({ status: "EXPIRED", expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const exp = await ensureStudioScriptAuthorization(expired, OWNER, JOB, {});
  assert.equal(refusal(exp).reason, "authorization expired");
  const uncertain = rpc({ data: { opened: false, reason: "uncertain operations must be reconciled first" } });
  assert.equal(refusal(await ensureStudioScriptAuthorization(uncertain, OWNER, JOB, {})).status, 409);
  assert.equal(refusal(await ensureStudioScriptAuthorization(rpc({ data: { opened: true } }), "not-a-uuid", JOB, {})).status, 400);
});

test("bind: triple, tabla ausente y dueño distinto fallan cerrado", async () => {
  const okRpc = rpc({ data: { bound: true, state: "bound", projectId: PROJECT, episodeId: EP, authorizationRef: studioScriptAuthorizationRef(JOB), transactionId: "7" } });
  const ok = await bindStudioScriptAuthorization(okRpc, OWNER, JOB, EP);
  assert.equal(ok.ok, true);
  const missing = rpc({ data: { bound: false, reason: "studio episodes table missing" } });
  assert.equal(refusal(await bindStudioScriptAuthorization(missing, OWNER, JOB, EP)).status, 503);
  const other = rpc({ data: { bound: false, reason: "authorization owner mismatch" } });
  assert.equal(refusal(await bindStudioScriptAuthorization(other, OWNER, JOB, EP)).status, 409);
  const bare = rpc({ data: { bound: true, state: "bound", projectId: PROJECT, episodeId: EP } });
  assert.equal(refusal(await bindStudioScriptAuthorization(bare, OWNER, JOB, EP)).reason, "triple_missing");
});

const V = (voiceId: string, name: string): AccountVoice => ({ voiceId, name, category: "premade", language: "es", accent: null, gender: null, previewUrl: null } as AccountVoice);
const spec = () => StudioSpec.parse({ version: STUDIO_VERSION, mode: "dialogo", title: "T", script: "Ana: Hola, ¿qué tal?\nLuis: Muy bien, gracias por invitarme.\nAna: ¿Qué es Europa?\nLuis: Una luna con océano bajo el hielo.", target_minutes: 1,
  participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "a1" } }, { id: "B", name: "Luis", voice_id: "voiceLuisGuest", avatar: { kind: "existente", avatar_id: "a2" } }],
  visual: {}, music: {}, budget_usd: 5 });
const createDeps = (over: Partial<ApiDeps> = {}): ApiDeps & { inserted: number; removed: string[] } => {
  const removed: string[] = [];
  const d: ApiDeps & { inserted: number; removed: string[] } = {
    userId: "u1", viewer: { id: "u1", email: "h@example.com", email_confirmed_at: "x" }, voices: async () => [V("voiceAnaHost1", "Ana"), V("voiceLuisGuest", "Luis")],
    enabled: true, llm: null, insert: async () => { d.inserted++; return { id: EP }; }, load: async () => null, authorize: async () => false, dispatch: async () => false,
    inserted: 0, removed, ...over,
  };
  return d;
};

test("crear episodio: flag apagado ignora scriptJobId; flag encendido vincula o borra el borrador", async () => {
  const off = createDeps();
  const a = await studioAction(off, { action: "create", spec: spec(), scriptJobId: JOB });
  assert.equal(a.status, 200); assert.equal(off.inserted, 1);
  const wired = createDeps({
    env: { PODCAST_STUDIO_SCRIPT_DURABLE_AUTH: "1" },
    bindStudioScript: async (job, episode) => ({ ok: true, state: "bound", projectId: PROJECT, episodeId: episode, authorizationRef: "r", transactionId: "3" }),
    removeDraft: async (id) => { wired.removed.push(id); return true; },
  });
  const b = await studioAction(wired, { action: "create", spec: spec(), scriptJobId: JOB });
  assert.equal(b.status, 200, JSON.stringify(b.body)); assert.equal(wired.inserted, 1); assert.deepEqual(wired.removed, []);
  const fail = createDeps({
    env: { PODCAST_STUDIO_SCRIPT_DURABLE_AUTH: "1" },
    bindStudioScript: async () => ({ ok: false, status: 503, reason: "rpc_error", error: "no" }),
    removeDraft: async (id) => { fail.removed.push(id); return true; },
  });
  const c = await studioAction(fail, { action: "create", spec: spec(), scriptJobId: JOB });
  assert.equal(c.status, 503); assert.equal(c.body.draftRemoved, true); assert.deepEqual(fail.removed, [EP]);
  const bad = createDeps({ env: { PODCAST_STUDIO_SCRIPT_DURABLE_AUTH: "1" }, bindStudioScript: async () => { throw new Error("no"); }, removeDraft: async () => true });
  const d = await studioAction(bad, { action: "create", spec: spec(), scriptJobId: "no-es-uuid" });
  assert.equal(d.status, 400); assert.equal(bad.inserted, 0);
  const unwired = createDeps({ env: { PODCAST_STUDIO_SCRIPT_DURABLE_AUTH: "1" } });
  const e = await studioAction(unwired, { action: "create", spec: spec(), scriptJobId: JOB });
  assert.equal(e.status, 503); assert.equal(unwired.inserted, 0);
});
