/**
 * Punto de entrada del worker de render en GitHub Actions. Lo dispara
 * `.github/workflows/render.yml` vía `repository_dispatch` cuando
 * `/api/generate/[id]/render` llama a la API de GitHub — no corre dentro
 * de Next.js, pero reutiliza exactamente el mismo pipeline
 * (src/lib/video/run-job.ts → src/lib/video/generate-video.ts) que ya se
 * verifica con `npm run test:pipeline`.
 *
 * T36 C1: toda la lógica vive en src/lib/video/worker-cli.ts (una sola función CLI). El recorrido local ejecuta
 * ESTE mismo archivo como proceso aparte; su modo fixture solo se abre si todas las condiciones locales se cumplen.
 *
 * Uso: REQUEST_ID=<uuid> npx tsx scripts/render-worker.ts
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

async function main() {
  const { runRenderWorkerCli } = await import("../src/lib/video/worker-cli");
  await runRenderWorkerCli(process.env);
}

main().catch((error: unknown) => {
  // Códigos de rechazo sin valores (WorkerRefusal); el detalle de un fallo de render queda en la solicitud privada.
  console.error(error instanceof Error && error.name === "WorkerRefusal" ? `RENDER_WORKER_REFUSED ${error.message}` : "RENDER_FAILED_DETAILS_IN_PRIVATE_REQUEST");
  process.exit(1);
});
