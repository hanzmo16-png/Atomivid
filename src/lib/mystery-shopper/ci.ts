/**
 * Mystery Shopper 2.0 — disparo automático (CI aprobado + Preview listo) y disparo manual, como funciones probables.
 *
 * El automático solo lo llama el workflow con un evento `deployment_status` de GitHub (no hay endpoint público) y solo
 * si Hans activó la variable MYSTERY_SHOPPER_AUTO=1. Comprueba repositorio, Preview success, URL de un Preview de este
 * proyecto, SHA de 40 hex y CI del SHA terminado sin fallos (espera acotada). El id de cada trabajo sale del SHA y la
 * misión: un evento repetido reutiliza el trabajo.
 */
import { defaultCatalog } from "./catalog";
import type { JobStore } from "./jobs";
import { startEvaluation } from "./start";

export type CiEnv = {
  repo: string; eventRepo?: string; state?: string; environment?: string; sha?: string; url?: string;
  autoFlag?: string; githubToken?: string; waitMin?: number; apiBase?: string;
};
export type CiOutcome = { accepted: boolean; reason: string; jobs: string[]; created: string[] };

const PREVIEW = /^https:\/\/atomivid-[a-z0-9-]+-atomivid\.vercel\.app$/;

export async function ciStart(e: CiEnv, deps: { store: JobStore; fetchImpl: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => Date; env: Record<string, string | undefined> }): Promise<CiOutcome> {
  const no = (reason: string): CiOutcome => ({ accepted: false, reason, jobs: [], created: [] });
  if (e.autoFlag !== "1") return no("MYSTERY_SHOPPER_AUTO no está activada: el disparo automático está apagado.");
  if (e.eventRepo !== e.repo) return no("el evento no es de este repositorio");
  if (e.state !== "success") return no(`despliegue en estado ${e.state}`);
  if (!/preview/i.test(e.environment ?? "")) return no(`entorno ${e.environment} no es Preview`);
  const sha = e.sha ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) return no("SHA no verificable");
  const url = (e.url ?? "").replace(/\/+$/, "");
  if (!PREVIEW.test(url)) return no("la URL no es un Preview de este proyecto");

  // CI aprobado: Vercel avisa del Preview antes de que el CI termine; se espera (acotado) a que todo termine sin fallos.
  const deadline = deps.now().getTime() + (e.waitMin ?? 30) * 60_000;
  for (;;) {
    const res = await deps.fetchImpl(`${e.apiBase ?? "https://api.github.com"}/repos/${e.repo}/commits/${sha}/check-runs?per_page=100`, { headers: { Authorization: `Bearer ${e.githubToken ?? ""}`, Accept: "application/vnd.github+json" } });
    if (!res.ok) return no(`no se pudo leer el CI (HTTP ${res.status})`);
    const runs = ((await res.json()) as { check_runs: { name: string; status: string; conclusion: string | null }[] }).check_runs.filter((r) => !/^(evaluar|automatico|pruebas)$/i.test(r.name));
    const bad = runs.filter((r) => r.status === "completed" && !["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
    if (bad.length) return no(`CI con fallos: ${bad.map((r) => r.name).join(", ")}`);
    const pending = runs.filter((r) => r.status !== "completed");
    if (runs.length && !pending.length) break;
    if (deps.now().getTime() > deadline) return no(`CI sin terminar tras la espera: ${pending.map((r) => r.name).join(", ") || "sin comprobaciones"}`);
    await deps.sleep(60_000);
  }

  const jobs: string[] = [], created: string[] = [];
  for (const m of defaultCatalog().missions.filter((x) => x.auto)) {
    const id = `ms-ci-${sha.slice(0, 12)}-${m.id}`.slice(0, 90);
    const r = await startEvaluation({ id, missionId: m.id, profile: m.id === "cuenta-navegacion" ? "impaciente" : "principiante", mode: "gratuito", target: url, source: "ci", requestedBy: "ci", requestedSha: sha },
      { store: deps.store, catalog: defaultCatalog(), dispatch: async () => ({ ok: true, detail: "el worker corre en este mismo workflow" }), now: deps.now, env: deps.env });
    if (r.created) created.push(id);
    if (!r.view.hasReport) jobs.push(id);
  }
  return { accepted: true, reason: `CI verde y Preview listo: ${jobs.length} trabajo(s)`, jobs, created };
}
