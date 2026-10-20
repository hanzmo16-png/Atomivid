/**
 * Worker de prueba para el escenario de IMÁGENES EXTRA (arnés local, USD 0). Hace lo mismo que worker-cli.ts
 * (lee la fila, exige status processing y el intento despachado, runRenderJob(requestId, attempt)) pero SIN su guarda
 * restrictFetchToLoopback, porque esa guarda (correcta en producción) impide por diseño redirigir la llamada del
 * adaptador REAL de OpenAI Images (endpoint fijo https://api.openai.com/v1/images/generations) a un mock local.
 * En su lugar, este proceso:
 *   - redirige SOLO POST https://api.openai.com/v1/images/generations → mock loopback (MOCK_OPENAI_URL);
 *   - rechaza cualquier otra salida no loopback (registrada en E2E_EGRESS_LOG).
 * Desviación documentada en el cierre: el entrypoint es runRenderJob (el mismo que llama worker-cli), no worker-cli.
 */
import fs from "node:fs";
const MOCK = process.env.MOCK_OPENAI_URL ?? "http://127.0.0.1:54600/v1/images/generations";
const LOG = process.env.E2E_EGRESS_LOG;
const original = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === "https://api.openai.com/v1/images/generations") return original(MOCK, init);
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!url.startsWith("data:") && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind: "worker_egress_refused", host }) + "\n");
    throw new Error(`worker-images: salida no loopback rechazada (${host})`);
  }
  return original(input, init);
}) as typeof fetch;

async function main() {
  const requestId = process.env.REQUEST_ID!;
  const { createServiceClient } = await import("@/lib/supabase/service");
  const row = await createServiceClient().from("video_requests").select("status,render_attempts").eq("id", requestId).single();
  if (row.error || !row.data) throw new Error("REQUEST_READ_FAILED");
  if (row.data.status !== "processing") { console.log("SKIPPED not processing"); return; }
  if (process.env.RENDER_ATTEMPT && Number(process.env.RENDER_ATTEMPT) !== row.data.render_attempts) { console.log("SKIPPED other attempt"); return; }
  // Igual que worker-cli.ts: el paso `if: failure()` de render.yml (mark-render-failed.ts) sólo cierra el intento que este
  // archivo nombra; sin él la red de seguridad no hace nada tras un SIGKILL.
  fs.writeFileSync(".render-attempt.json", JSON.stringify({ requestId, attempt: row.data.render_attempts }), { mode: 0o600 });
  const { runRenderJob } = await import("@/lib/video/run-job");
  await runRenderJob(requestId, row.data.render_attempts as number);
  console.log("RAN");
}
main().catch((e) => { console.error("WORKER_IMAGES_FAILED", e instanceof Error ? e.message : String(e)); process.exit(1); });
