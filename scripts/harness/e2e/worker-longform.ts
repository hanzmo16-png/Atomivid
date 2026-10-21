/**
 * Worker de prueba del ENSAYO LONG FORM (arnés local, USD 0; Grok T-20261021-0530). Igual que worker-images.ts: lee la fila,
 * exige status processing y el intento despachado, y llama runRenderJob (el mismo entrypoint que worker-cli/render-worker),
 * pero SIN restrictFetchToLoopback, porque los adaptadores REALES (ElevenLabs/Pexels/OpenAI/Commons) tienen endpoints fijos.
 * Este proceso redirige SOLO esos hosts a mocks loopback (mock-longform-providers.mjs) y rechaza cualquier otra salida.
 * Las claves son falsas («local-fake-…»): aunque una redirección faltara, la salida sería rechazada, nunca enviada.
 */
import fs from "node:fs";
const M = process.env.MOCK_LF_URL ?? "http://127.0.0.1:54610";
const LOG = process.env.E2E_EGRESS_LOG;
const original = globalThis.fetch;
const MAP: [RegExp, string][] = [
  [/^https:\/\/api\.elevenlabs\.io\//, `${M}/el/`],
  [/^https:\/\/api\.pexels\.com\/videos\//, `${M}/pexels/videos/`],
  [/^https:\/\/api\.pexels\.com\/v1\//, `${M}/pexels/v1/`],
  [/^https:\/\/commons\.wikimedia\.org\/w\/api\.php/, `${M}/commons`],
  [/^https:\/\/api\.openai\.com\/v1\/images\/generations$/, `${M}/openai/v1/images/generations`],
];
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  for (const [re, to] of MAP) if (re.test(url)) return original(url.replace(re, to), init ?? (input instanceof Request ? input : undefined));
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!url.startsWith("data:") && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind: "worker_egress_refused", host }) + "\n");
    throw new Error(`worker-longform: salida no loopback rechazada (${host})`);
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
  fs.writeFileSync(".render-attempt.json", JSON.stringify({ requestId, attempt: row.data.render_attempts }), { mode: 0o600 });
  const { runRenderJob } = await import("@/lib/video/run-job");
  await runRenderJob(requestId, row.data.render_attempts as number);
  console.log("RAN");
}
main().catch((e) => { console.error("WORKER_LONGFORM_FAILED", e instanceof Error ? `${e.name}: ${e.message}` : String(e)); process.exit(1); });
