/**
 * Mystery Shopper 2.0 — disparo automático: CI aprobado + Preview listo → trabajos gratuitos → worker.
 *
 * Corre SOLO dentro de GitHub Actions con un evento `deployment_status` que emite la integración de Vercel en GitHub
 * (no hay endpoint público que lo acepte). Comprueba:
 *  - el repositorio del evento es este repositorio;
 *  - el despliegue es un Preview en estado success y su URL es un Preview de ESTE proyecto;
 *  - el SHA tiene 40 hex y todas sus comprobaciones de CI terminaron sin fallo (excepto este mismo workflow);
 *  - cada misión automática del catálogo es gratuita.
 * El id de cada trabajo sale del SHA y la misión: el mismo evento repetido reutiliza el trabajo (no lanza otro).
 */
import { appendFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { defaultCatalog } from "../../src/lib/mystery-shopper/catalog";
import { jobStore, MS_BUCKET, type StorageApi } from "../../src/lib/mystery-shopper/jobs";
import { startEvaluation } from "../../src/lib/mystery-shopper/start";

const env = process.env;
const fail = (m: string): never => { console.log(`[mystery-shopper:ci] rechazado: ${m}`); process.exit(0); };

async function main() {
  const repo = env.GITHUB_REPOSITORY ?? "";
  if (env.MS_EVENT_REPO !== repo) fail("el evento no es de este repositorio");
  if (env.MS_EVENT_STATE !== "success") fail(`despliegue en estado ${env.MS_EVENT_STATE}`);
  if (!/preview/i.test(env.MS_EVENT_ENVIRONMENT ?? "")) fail(`entorno ${env.MS_EVENT_ENVIRONMENT} no es Preview`);
  const sha = env.MS_EVENT_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) fail("SHA no verificable");
  const url = (env.MS_EVENT_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/atomivid-[a-z0-9-]+-atomivid\.vercel\.app$/.test(url)) fail("la URL no es un Preview de este proyecto");

  // CI aprobado: Vercel avisa del Preview antes de que el CI termine, así que se espera (gratis, en este runner) hasta
  // que todas las comprobaciones del SHA terminen (máx. MS_CI_WAIT_MIN minutos) y ninguna haya fallado.
  const deadline = Date.now() + Number(env.MS_CI_WAIT_MIN || 30) * 60_000;
  for (;;) {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" } });
    if (!res.ok) fail(`no se pudo leer el CI (HTTP ${res.status})`);
    const runs = ((await res.json()) as { check_runs: { name: string; status: string; conclusion: string | null }[] }).check_runs.filter((r) => !/^(evaluar|automatico|pruebas)$/i.test(r.name));
    const bad = runs.filter((r) => r.status === "completed" && !["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
    if (bad.length) fail(`CI con fallos: ${bad.map((r) => r.name).join(", ")}`);
    const pending = runs.filter((r) => r.status !== "completed");
    if (runs.length && !pending.length) break;
    if (Date.now() > deadline) fail(`CI sin terminar tras la espera: ${pending.map((r) => r.name).join(", ") || "sin comprobaciones"}`);
    console.log(`[mystery-shopper:ci] esperando al CI: ${pending.length} comprobación(es) en curso`);
    await new Promise((r) => setTimeout(r, 60_000));
  }

  const key = env.SUPABASE_SERVICE_ROLE_KEY, sb = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
  if (!key || !sb) fail("faltan los secretos de Supabase del worker");
  const store = jobStore(createClient(sb!, key!, { auth: { persistSession: false } }).storage.from(MS_BUCKET) as unknown as StorageApi);
  const ids: string[] = [];
  for (const m of defaultCatalog().missions.filter((x) => x.auto)) {
    const id = `ms-ci-${sha.slice(0, 12)}-${m.id}`.slice(0, 90);
    const r = await startEvaluation({ id, missionId: m.id, profile: m.id === "cuenta-navegacion" ? "impaciente" : "principiante", mode: "gratuito", target: url, source: "ci", requestedBy: "ci", requestedSha: sha },
      { store, catalog: defaultCatalog(), dispatch: async () => ({ ok: true, detail: "el worker corre en este mismo workflow" }), now: () => new Date(), env });
    console.log(`[mystery-shopper:ci] ${id}: ${r.message}`);
    if (!r.view.hasReport) ids.push(id);
  }
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `jobs=${JSON.stringify(ids)}\n`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
