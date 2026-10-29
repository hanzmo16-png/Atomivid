/** Runs only when the podcast worker step died (timeout/cancel/crash): leave a clear, retryable state. */
export {};
import { readFile } from "node:fs/promises";

/** Mensaje visible cuando el trabajo no llegó a empezar: nada se cobró y el inicio se puede volver a pedir. */
const STUDIO_NOT_STARTED = "No se pudo iniciar la generación por un fallo del servidor (antes de cualquier cargo). Tu autorización se conserva: pulsa «Volver a pedir el inicio»; no se cobra otra vez.";

async function main() {
  const fromFile = process.env.PODCAST_TOKEN_FILE ? (await readFile(`${process.env.PODCAST_TOKEN_FILE}.episode`, "utf8").catch(() => "")).trim() : "";
  const id = process.env.EPISODE_ID?.trim() || fromFile;
  if (!/^[0-9a-f-]{36}$/i.test(id) || process.env.JOB_KIND === "narration" || process.env.JOB_KIND === "notices") return;
  const { createServiceClient } = await import("../src/lib/supabase/service");
  if (process.env.JOB_KIND === "studio") {
    // Podcast 3.0: el runner murió (tiempo/cancelación). Un solo trabajo por episodio a la vez (concurrency del workflow),
    // así que «generating» es esta ejecución. Lo que quedó «reserved» pudo cobrarse: pasa a «uncertain» (no se reintenta
    // a ciegas, se concilia). Lo liquidado y su archivo en Storage se reutilizan al pulsar «Reintentar».
    const service = createServiceClient();
    const { data } = await service.from("podcast_studio_episodes").update({ status: "failed", error: "La generación se interrumpió. Lo ya pagado se conserva y se reutiliza al reintentar; no se cobra dos veces.", updated_at: new Date().toISOString() })
      .eq("id", id).eq("status", "generating").select("id");
    if (data?.length) await service.from("podcast_studio_operations").update({ state: "uncertain", updated_at: new Date().toISOString() }).eq("episode_id", id).eq("state", "reserved");
    console.log("STUDIO_MARKED_FAILED", data?.length ?? 0);
    if (data?.length) return;
    // El trabajo murió ANTES de tomar el episodio (p. ej. falló la instalación del entorno, 2026-10-29 ec30c594): sigue
    // «authorized», sin ningún cargo, y la pantalla lo mostraba en 0 % sin explicación. Se deja autorizado (así «Volver a
    // pedir el inicio» no vuelve a autorizar ni cobra) y se explica. Solo si ningún worker lo tomó tras esta autorización.
    const { data: row } = await service.from("podcast_studio_episodes").select("status,authorized_at,run_started_at").eq("id", id).maybeSingle();
    const r = row as { status: string; authorized_at: string | null; run_started_at: string | null } | null;
    const notStarted = r?.status === "authorized" && !!r.authorized_at && (!r.run_started_at || Date.parse(r.run_started_at) < Date.parse(r.authorized_at));
    if (notStarted) {
      const { data: noted } = await service.from("podcast_studio_episodes").update({ error: STUDIO_NOT_STARTED, updated_at: new Date().toISOString() })
        .eq("id", id).eq("status", "authorized").eq("authorized_at", r!.authorized_at!).select("id");
      console.log("STUDIO_NOT_STARTED_NOTED", noted?.length ?? 0);
    }
    return;
  }
  // The run token this job claimed (written by the worker right after its claim), when it got that far.
  const token = process.env.PODCAST_TOKEN_FILE ? (await readFile(process.env.PODCAST_TOKEN_FILE, "utf8").catch(() => "")).trim() : "";
  const patch = {
    video_status: "failed", video_stage: null, updated_at: new Date().toISOString(),
    video_error: "La producción se interrumpió. La narración y lo ya pagado se conservan; pulsa «Reintentar».",
  };
  const service = createServiceClient();
  const query = service.from("podcast_episodes").update(patch).eq("id", id).in("video_status", ["queued", "running"]);
  // With the token: exactly this job's run, even when it was cancelled seconds after its last heartbeat; a newer
  // request carries another token and is left alone. Without it (died before claiming): only a run that stopped beating.
  const { data } = await (token ? query.eq("video_run_token", token) : query.lt("video_heartbeat_at", new Date(Date.now() - 90_000).toISOString())).select("id,user_id");
  // One "blocked" notice for this run (the owner may have closed the app); never one per step.
  const row = data?.[0] as { id: string; user_id: string } | undefined;
  if (row && token) {
    const pilot = await import("../src/lib/podcast/pilot-server");
    const notice = await pilot.recordNotice(service, row, "blocked", token, patch.video_error);
    if (notice) await pilot.deliverGithubNotice(service, notice);
  }
}
main().catch(() => { process.exitCode = 1; });
