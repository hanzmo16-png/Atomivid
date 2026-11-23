/**
 * Mystery Shopper 2.0 — iniciar una evaluación de verdad.
 *
 * Panel o CI → reserva atómica del trabajo (Storage) → despacho del worker de GitHub Actions → el worker abre un
 * navegador NUEVO contra ATOMIVID y escribe evidencias e informe en el mismo trabajo. Aquí no se graba ni se devuelve
 * ningún recorrido: si no hay worker, el trabajo queda en cola y lo dice; nunca se presenta un informe viejo como nuevo.
 */
import { missionById, type Catalog } from "./catalog";
import { assertJobId, MAX_ATTEMPTS, STALE_MS, type Job, type JobMode, type JobStore, type JobView, type Target } from "./jobs";
import { PROFILES, type ProfileId } from "./types";

export const DISPATCH_EVENT = "mystery-shopper-run";
/** Despachos por trabajo. Repetir el despacho es inocuo (el claim del worker es atómico), pero se acota. */
export const MAX_DISPATCHES = 3;
/** Presupuesto aprobado hoy por Hans para el modo real. Mientras sea 0, el modo real no corre. */
export const APPROVED_REAL_BUDGET_USD = 0;

const PROD_HOST = /^atomivid\.vercel\.app$/;
const PREVIEW_HOST = /^atomivid-[a-z0-9-]+-atomivid\.vercel\.app$/;

export function resolveTarget(raw: string | undefined, env: Record<string, string | undefined>): Target {
  const url = (raw || env.MYSTERY_SHOPPER_TARGET_URL || "https://atomivid.vercel.app").replace(/\/+$/, "");
  let u: URL;
  try { u = new URL(url); } catch { throw new StartError(400, "La dirección a evaluar no es válida."); }
  if (u.protocol === "https:" && PROD_HOST.test(u.hostname)) return { kind: "production", url: u.origin };
  if (u.protocol === "https:" && PREVIEW_HOST.test(u.hostname)) return { kind: "preview", url: u.origin };
  if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && env.MYSTERY_SHOPPER_ALLOW_LOCAL === "1") return { kind: "local", url: u.origin };
  throw new StartError(400, "Solo se evalúa ATOMIVID (producción o un Preview de este proyecto).");
}

export class StartError extends Error { constructor(readonly http: number, m: string) { super(m); this.name = "StartError"; } }

export type StartInput = {
  id: string;
  missionId: string;
  profile: string;
  mode?: string;
  target?: string;
  maxBudgetUsd?: number;
  source: "panel" | "ci";
  requestedBy: string;
  requestedSha: string;
};

export type Dispatcher = (payload: { jobId: string; attempt: number }) => Promise<{ ok: boolean; detail: string }>;

export type StartResult = { http: number; view: JobView; created: boolean; dispatched: boolean; message: string };

export async function startEvaluation(input: StartInput, deps: { store: JobStore; catalog: Catalog; dispatch: Dispatcher; now: () => Date; env: Record<string, string | undefined> }): Promise<StartResult> {
  assertJobId(input.id);
  let mission;
  try { mission = missionById(deps.catalog, input.missionId); } catch (e) { throw new StartError(400, e instanceof Error ? e.message : "Misión no válida."); }
  if (!(PROFILES as readonly string[]).includes(input.profile)) throw new StartError(400, "Perfil no válido.");
  const mode: JobMode = input.mode === "real" ? "real" : "gratuito";
  const maxBudgetUsd = mode === "real" ? Number(input.maxBudgetUsd ?? 0) : 0;
  if (mode === "real" && !(maxBudgetUsd > 0)) throw new StartError(409, "El modo real necesita un presupuesto mayor que USD 0 aprobado por Hans. Presupuesto aprobado hoy: USD 0.");
  if (mode === "real" && maxBudgetUsd > APPROVED_REAL_BUDGET_USD) throw new StartError(409, `El presupuesto pedido (USD ${maxBudgetUsd.toFixed(2)}) supera el aprobado por Hans (USD ${APPROVED_REAL_BUDGET_USD.toFixed(2)}). No se crea nada.`);
  const target = resolveTarget(input.target, deps.env);
  const now = deps.now();
  const job: Job = {
    v: 2, id: input.id, missionId: mission.id, product: mission.product, profile: input.profile as ProfileId, mode, target,
    source: input.source, requestedBy: input.requestedBy, requestedAt: now.toISOString(), requestedSha: input.requestedSha, maxBudgetUsd,
  };
  const { created, view } = await deps.store.reserve(job, now.toISOString());
  // El mismo id con otra misión/perfil/destino no es un reintento: es un conflicto (no se mezcla con lo existente).
  if (!created && (view.job.missionId !== job.missionId || view.job.profile !== job.profile || view.job.target.url !== job.target.url || view.job.mode !== job.mode)) {
    throw new StartError(409, "Ese id ya pertenece a otra evaluación.");
  }
  const st = view.status;
  const beat = Date.parse(st.heartbeatAt ?? st.updatedAt);
  const stale = st.state === "en_proceso" && Number.isFinite(beat) && now.getTime() - beat >= STALE_MS;
  const needsWorker = !view.hasReport && (st.state === "en_cola" || stale) && st.attempt < MAX_ATTEMPTS;
  if (!needsWorker) {
    return { http: 200, view, created, dispatched: false, message: created ? "Evaluación creada." : "Esta evaluación ya existe: se muestra la misma, no se lanza otra." };
  }
  // Un despacho por solicitud que lo necesita, acotado. Si se pierde la respuesta, reintentar con el mismo id vuelve
  // aquí; un despacho repetido no duplica nada porque el worker gana el trabajo con un claim atómico.
  const ds = await deps.store.dispatchState(input.id);
  // Doble clic, respuesta perdida o reintento de red: si ya hay un despacho confirmado y el worker no murió, no se
  // vuelve a encolar. Solo se repite si el anterior falló o si el worker quedó sin latido.
  // Un despacho en vuelo (pedido, sin confirmar ni fallar) cuenta como pedido: dos solicitudes simultáneas no encolan dos.
  if (ds.count > ds.failed && !stale) return { http: 200, view, created, dispatched: false, message: "Esta evaluación ya está en cola: no se lanza otra." };
  const n = ds.count + 1;
  if (n > MAX_DISPATCHES) return { http: 200, view, created, dispatched: false, message: `Ya se pidió el worker ${MAX_DISPATCHES} veces para esta evaluación. Revisa el worker antes de repetir.` };
  const recorded = await deps.store.recordDispatch(input.id, n, { at: now.toISOString(), source: input.source, stale });
  if (!recorded) return { http: 200, view, created, dispatched: false, message: "Otra solicitud ya pidió el worker para esta evaluación." };
  const d = await deps.dispatch({ jobId: input.id, attempt: n });
  if (d.ok) await deps.store.markDispatchOk(input.id, n).catch(() => false);
  else await deps.store.markDispatchFailed(input.id, n, d.detail).catch(() => false);
  return { http: created ? 201 : 200, view, created, dispatched: d.ok, message: d.ok ? "Evaluación en cola: el worker abrirá un navegador nuevo." : `La evaluación quedó guardada, pero no se pudo avisar al worker: ${d.detail}` };
}

/** Despacho real del workflow (mismo token y repo que el worker de video; no se crean secretos nuevos). */
export function githubDispatcher(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Dispatcher {
  return async ({ jobId, attempt }) => {
    const token = env.GH_WORKER_TOKEN, repo = env.GH_WORKER_REPO;
    if (!token || !repo || !/^[^\s/]+\/[^\s/]+$/.test(repo)) return { ok: false, detail: "falta GH_WORKER_TOKEN/GH_WORKER_REPO" };
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/dispatches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        body: JSON.stringify({ event_type: DISPATCH_EVENT, client_payload: { jobId, attempt } }),
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok ? { ok: true, detail: `HTTP ${res.status}` } : { ok: false, detail: `GitHub respondió HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : "error de red" };
    }
  };
}
