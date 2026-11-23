/**
 * Entrada del panel y del worker. No abre red hacia proveedores.
 * En Vercel el navegador no corre: el informe fixture sale del recorrido ya grabado, marcado como fixture.
 */
import { editMission, missionById, parseCatalog, type Catalog, defaultCatalog } from "./catalog";
import { RUNNER_NOTE, acceptCiEvent, type CiEvent } from "./ci-trigger";
import { reportFromJourney } from "./evaluate";
import { decideRealMode, emptyLedger, type Ledger } from "./real-mode";
import { startIdempotent, type ReportStore } from "./store";
import { FLOW_STEPS, PRODUCTS, PROFILES, type Journey, type ProductId, type ProfileId, type RunReport } from "./types";

export type MysteryBody = {
  action?: string;
  mode?: string;
  product?: string;
  profile?: string;
  missionId?: string;
  instructions?: string;
  maxBudgetUsd?: number;
  idempotencyKey?: string;
  approver?: string;
  estimateUsd?: number | null;
  estimateVerified?: boolean;
  knownCost?: boolean;
  reservationId?: string;
  maxRetries?: number;
  attempt?: number;
  cancelRequested?: boolean;
  event?: CiEvent;
  catalog?: unknown;
};

export type HandlerDeps = {
  env: Record<string, string | undefined>;
  now: () => string;
  store: ReportStore;
  ledger: Ledger;
  sha: string;
  environment: string;
  /** Recorridos fixture grabados por el worker, uno por misión. El HTTP no puede inventar uno. */
  recordedJourneys?: Journey[];
  seenExecutions?: Set<string>;
};

function isProduct(v: string): v is ProductId {
  return (PRODUCTS as readonly string[]).includes(v);
}
function isProfile(v: string): v is ProfileId {
  return (PROFILES as readonly string[]).includes(v);
}

function blockedReport(deps: HandlerDeps, input: { id: string; product: ProductId; profile: ProfileId; missionId: string; instructions: string; maxBudgetUsd: number; reason: string; code: string; mode: "fixture" | "real" }, catalogNote: string): RunReport {
  const started = deps.now();
  const journey: Journey = {
    scope: "no-observado",
    missionId: input.missionId,
    sha: deps.sha,
    environment: deps.environment,
    baseUrl: "",
    steps: FLOW_STEPS.map((name, i) => ({ step: i + 1, name, status: "blocked" as const, screen: "Sin recorrido", visibleText: "", detail: input.reason, clicks: 0, fields: 0, decisions: 0 })),
    screens: [],
    products: [],
    media: null,
    mediaByProduct: {},
    spendUsd: 0,
    evidence: [{ label: "bloqueo", note: catalogNote }],
    errors: [input.reason],
    liveProbe: null,
  };
  return reportFromJourney({
    id: input.id,
    idempotencyKey: input.id,
    mode: input.mode,
    product: input.product,
    profile: input.profile,
    missionId: input.missionId,
    instructions: input.instructions,
    startedAt: started,
    finishedAt: deps.now(),
    maxBudgetUsd: input.maxBudgetUsd,
    realMode: { executed: false, code: input.code, reason: input.reason },
    journey,
  });
}

export async function handleMystery(body: MysteryBody, deps: HandlerDeps, catalog: Catalog = defaultCatalog()): Promise<{ http: number; payload: unknown; catalog: Catalog; ledger: Ledger }> {
  const action = body.action ?? "start";
  if (action === "catalog") {
    try {
      const next = body.catalog ? parseCatalog(body.catalog) : catalog;
      const edited = body.missionId && body.instructions ? editMission(next, body.missionId, { instructions: body.instructions }) : next;
      return { http: 200, payload: { catalog: edited }, catalog: edited, ledger: deps.ledger };
    } catch (e) {
      return { http: 400, payload: { error: e instanceof Error ? e.message : "Catálogo rechazado." }, catalog, ledger: deps.ledger };
    }
  }
  if (action === "ci") {
    if (!body.event) return { http: 400, payload: { error: "Falta el evento." }, catalog, ledger: deps.ledger };
    const decision = acceptCiEvent(body.event, deps.seenExecutions ?? new Set());
    return { http: decision.accept ? 202 : 200, payload: decision, catalog, ledger: deps.ledger };
  }

  const missionId = String(body.missionId ?? "");
  let mission;
  try { mission = missionById(catalog, missionId); } catch (e) {
    return { http: 400, payload: { error: e instanceof Error ? e.message : "Misión rechazada." }, catalog, ledger: deps.ledger };
  }
  let nextCatalog = catalog;
  if (body.instructions && body.instructions !== mission.instructions) {
    try { nextCatalog = editMission(catalog, mission.id, { instructions: body.instructions }); mission = missionById(nextCatalog, mission.id); }
    catch (e) { return { http: 400, payload: { error: e instanceof Error ? e.message : "Instrucciones rechazadas." }, catalog, ledger: deps.ledger }; }
  }
  if (!isProduct(String(body.product ?? mission.product)) || !isProfile(String(body.profile ?? ""))) {
    return { http: 400, payload: { error: "Producto o perfil no válido." }, catalog: nextCatalog, ledger: deps.ledger };
  }
  const product = body.product as ProductId;
  if (product !== mission.product) return { http: 400, payload: { error: "La misión no corresponde al producto." }, catalog: nextCatalog, ledger: deps.ledger };
  const profile = body.profile as ProfileId;
  const key = String(body.idempotencyKey ?? "");
  if (!/^[a-zA-Z0-9:_-]{8,120}$/.test(key)) return { http: 400, payload: { error: "Falta un id de ejecución." }, catalog: nextCatalog, ledger: deps.ledger };

  const mode = body.mode === "real" ? "real" : "fixture";
  const decision = decideRealMode({
    mode,
    approver: body.approver,
    missionId: mission.id,
    expectedMissionId: mission.id,
    maxBudgetUsd: body.maxBudgetUsd,
    estimateUsd: body.estimateUsd,
    estimateVerified: body.estimateVerified,
    knownCost: body.knownCost,
    reservationId: body.reservationId,
    idempotencyKey: key,
    maxRetries: body.maxRetries,
    attempt: body.attempt,
    cancelRequested: body.cancelRequested || action === "cancel",
    hansAuth: deps.env.MYSTERY_SHOPPER_HANS_AUTH,
  }, deps.ledger);

  if (mode === "real" || action === "cancel") {
    const report = blockedReport(deps, { id: key, product, profile, missionId: mission.id, instructions: mission.instructions, maxBudgetUsd: body.maxBudgetUsd ?? 0, reason: decision.reason, code: decision.code, mode: "real" }, "Modo real sin ejecución.");
    const saved = await startIdempotent(deps.store, key, async () => report);
    return { http: 200, payload: saved.report, catalog: nextCatalog, ledger: decision.ledger };
  }

  const recorded = (deps.recordedJourneys ?? []).find((j) => j.missionId === mission.id) ?? null;
  if (!recorded || recorded.scope !== "fixture-harness" || recorded.spendUsd !== 0) {
    const report = blockedReport(deps, { id: key, product, profile, missionId: mission.id, instructions: mission.instructions, maxBudgetUsd: body.maxBudgetUsd ?? 0, reason: RUNNER_NOTE, code: "runner", mode: "fixture" }, "Sin recorrido fixture.");
    const saved = await startIdempotent(deps.store, key, async () => report);
    return { http: 200, payload: saved.report, catalog: nextCatalog, ledger: emptyLedger() };
  }

  const started = deps.now();
  const saved = await startIdempotent(deps.store, key, async () => reportFromJourney({
    id: key,
    idempotencyKey: key,
    mode: "fixture",
    product,
    profile,
    missionId: mission.id,
    instructions: mission.instructions,
    startedAt: started,
    finishedAt: deps.now(),
    maxBudgetUsd: 0,
    realMode: { executed: false, code: "fixture", reason: "Modo gratuito. Gasto USD 0. El recorrido es el arnés fixture, no una sesión de producción." },
    journey: { ...recorded, sha: recorded.sha || deps.sha, environment: recorded.environment || deps.environment, spendUsd: 0 },
  }));
  return { http: 200, payload: saved.report, catalog: nextCatalog, ledger: deps.ledger };
}

export function redact(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[correo]")
    .replace(/\b(sk|rk|pk|whsec|eyJ)[A-Za-z0-9_\-]{8,}\b/g, "[secreto]")
    .replace(/MYSTERY_SHOPPER_HANS_AUTH=\S+/g, "MYSTERY_SHOPPER_HANS_AUTH=[secreto]");
}
