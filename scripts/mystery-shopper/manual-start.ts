/**
 * Ejecución manual (workflow_dispatch sin job_id): crea UNA evaluación gratuita con la misma reserva atómica que el
 * panel y escribe su id en GITHUB_OUTPUT para que el worker la recorra en este mismo workflow. Con MS_JOB_ID dado,
 * reutiliza ese trabajo (un segundo despacho con el mismo id no crea ni repite nada).
 */
import { appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { defaultCatalog } from "../../src/lib/mystery-shopper/catalog";
import { jobStore, MS_BUCKET, newJobId, type StorageApi } from "../../src/lib/mystery-shopper/jobs";
import { startEvaluation } from "../../src/lib/mystery-shopper/start";

const env = process.env;
async function main() {
  const sb = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sb || !key) throw new Error("faltan los secretos de Supabase del worker");
  const store = jobStore(createClient(sb, key, { auth: { persistSession: false } }).storage.from(MS_BUCKET) as unknown as StorageApi);
  if (env.MS_JOB_ID) {
    // Trabajo ya creado (panel o reintento): se reutiliza tal cual; el claim del worker decide si corre o no.
    const view = await store.get(env.MS_JOB_ID);
    if (!view) throw new Error(`no existe la evaluación ${env.MS_JOB_ID}`);
    console.log(`[mystery-shopper:manual] ${env.MS_JOB_ID}: existente (estado ${view.status.state}, informe ${view.hasReport ? "sí" : "no"})`);
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `job=${env.MS_JOB_ID}\n`);
    return;
  }
  const id = newJobId(new Date(), () => randomBytes(5).toString("hex"));
  const r = await startEvaluation({ id, missionId: env.MS_MISSION || "cuenta-navegacion", profile: env.MS_PROFILE || "principiante", mode: "gratuito", target: env.MS_TARGET || undefined,
    source: "panel", requestedBy: "manual", requestedSha: env.GITHUB_SHA || "desconocido" },
    { store, catalog: defaultCatalog(), dispatch: async () => ({ ok: true, detail: "el worker corre en este mismo workflow" }), now: () => new Date(), env });
  console.log(`[mystery-shopper:manual] ${id}: ${r.message} (estado ${r.view.status.state}, informe ${r.view.hasReport ? "sí" : "no"})`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `job=${id}\n`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
