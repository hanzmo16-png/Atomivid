/**
 * Diagnóstico de SOLO LECTURA para scripts/heygen-owner-trial.ts — no escribe
 * nada, no descarga fotos/audio, no llama a HeyGen, no toca el candado ni el
 * saldo. Sirve para averiguar por qué `TRIAL_ACTION=generate` rechazó el
 * intento con "trial_not_eligible" tras dos ejecuciones consecutivas
 * ("prepare" reportó éxito ambas veces) sin exponer nada privado: solo
 * imprime booleanos/estado/contador, nunca rutas, IDs de proveedor ni
 * contenido.
 *
 * Hipótesis a confirmar: `heygen-owner-trial.ts` usa
 * `upsert(..., {onConflict:"id", ignoreDuplicates:true})` en modo "prepare"
 * — si ya existía una fila con ese mismo id (determinístico, derivado del
 * hash del id de origen) en un estado no elegible (render_attempts!=0 o
 * avatar_generation_started_at ya seteado), el upsert la deja intacta SIN
 * error, "prepare" reporta éxito igualmente, y "generate" la rechaza porque
 * no cumple los criterios frescos de elegibilidad.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { trialId } from "./heygen-owner-trial";

const SOURCE_HASH = "24ad45b839f41c3c20e23d3a1b85e5d4e946fd66d1bead27865e4dbd506239b5";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");

async function main() {
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const sourceRows = await service
    .from("video_requests")
    .select("id,status,avatar_provider_video_job_id")
    .eq("mode", "avatar");
  if (sourceRows.error) throw new Error("source_read_failed");
  const source = sourceRows.data?.find((r) => hash(r.id) === SOURCE_HASH);
  console.log(
    "1) Fila de origen (source):",
    JSON.stringify({
      found: Boolean(source),
      status: source?.status ?? null,
      hasProviderJobId: Boolean(source?.avatar_provider_video_job_id),
    }),
  );
  if (!source) {
    console.log("DIAGNOSTICO_FINALIZADO_SOURCE_NO_ENCONTRADA");
    return;
  }

  const id = trialId(source.id);
  const { data: row, error } = await service
    .from("video_requests")
    .select("status,render_attempts,avatar_generation_started_at,avatar_provider_video_job_id,recorded_audio_path")
    .eq("id", id)
    .maybeSingle();

  console.log(
    "2) Fila del intento (trial, derivada del id de origen):",
    JSON.stringify({
      exists: Boolean(row),
      queryError: error?.message ?? null,
      status: row?.status ?? null,
      renderAttempts: row?.render_attempts ?? null,
      hasGenerationStartedAt: Boolean(row?.avatar_generation_started_at),
      hasProviderJobId: Boolean(row?.avatar_provider_video_job_id),
      hasRecordedAudioPath: Boolean(row?.recorded_audio_path),
    }),
  );

  if (!row) {
    console.log("DIAGNOSTICO: la fila del intento NO existe — 'prepare' no la creó (revisar permisos/errores silenciosos del upsert).");
  } else if (row.status !== "script_ready") {
    console.log(`DIAGNOSTICO: status="${row.status}" (se esperaba "script_ready") — probablemente una fila preexistente de un intento anterior.`);
  } else if (row.render_attempts !== 0) {
    console.log(`DIAGNOSTICO: render_attempts=${row.render_attempts} (se esperaba 0) — fila preexistente reutilizada por ignoreDuplicates:true.`);
  } else if (row.avatar_generation_started_at) {
    console.log("DIAGNOSTICO: avatar_generation_started_at YA está seteado — la reserva de intento único de un intento anterior sigue activa.");
  } else if (row.avatar_provider_video_job_id) {
    console.log("DIAGNOSTICO: avatar_provider_video_job_id YA está seteado — ya se había creado un job en el proveedor antes.");
  } else {
    console.log("DIAGNOSTICO: la fila luce elegible según estos criterios — el fallo debe estar en otra verificación (integridad de archivos copiados, duración, etc).");
  }

  console.log("DIAGNOSTICO_FINALIZADO_SIN_ESCRITURAS_NI_LLAMADAS_A_PROVEEDOR");
}

main().catch((err) => {
  console.error("DIAGNOSTICO_FALLÓ:", err instanceof Error ? err.message : "error desconocido");
  process.exitCode = 1;
});
