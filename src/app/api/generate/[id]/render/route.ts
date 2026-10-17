import { usesVisualIdentity, type ProductionPlan } from "@/lib/video/long-form/production-plan-types";
import type { ProductionPlanBeatInput } from "@/lib/video/long-form/production-plan";
import { providerCheck, visualBlockMessage, visualCheck } from "@/lib/video/long-form/production-preflight";
import { isLongFormScriptJson } from "@/lib/video/long-form/script-json";
import { editorialApprovalError } from "@/lib/video/long-form/editorial";
import { SupplyUnavailableError } from "@/lib/supply/policy";
import { jobSupplyDemands, releaseUnusedJobSupply, reserveJobSupply } from "@/lib/supply/job";
import { ensureJobSupplyReady, START_SUPPLY_UNAVAILABLE } from "@/lib/supply/readiness";
import { supplyGuardRequired } from "@/lib/supply/server";
import { getVoiceProvider } from "@/lib/providers/voice";
import { NextResponse } from "next/server";
import type { StartOutcome } from "@/lib/video/start-outcome";
import { preReservationFailure } from "@/lib/video/start-failure";
import { encodeStoredFailure } from "@/lib/video/failure-action";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getRenderWorker } from "@/lib/worker";
import { assertCanGenerate } from "@/lib/billing/quota";
import { loadAvatarRecovery } from "@/lib/video/avatar/recovery";
import { avatarRenderDurationError } from "@/lib/video/avatar/duration";
import { evaluateRenderStart } from "@/lib/video/render-guard";
import {
  classifyRenderError,
  classifyRenderFailure,
  generateDiagnosticId,
  logRenderError,
  RenderStageError,
} from "@/lib/video/render-error";
import type { GeneratedScript } from "@/lib/providers/types";
import { directorRenderAllowed } from "@/lib/video/director/render-access";

// El worker por defecto (GitHub Actions) solo dispara un webhook y
// retorna — esta función ya no espera el render completo. maxDuration se
// mantiene alto solo como red de seguridad para el worker "inline", que
// sí corre el pipeline dentro de esta misma request — pero getRenderWorker()
// (src/lib/worker/index.ts) nunca lo selecciona en Vercel, así que en
// Production/Preview esta función jamás llega a usar ese tiempo. Sigue
// siendo relevante para quien corra esta ruta localmente sin GH_WORKER_TOKEN/
// GH_WORKER_REPO configurados.
export const maxDuration = 300;

type VideoRequestRow = {
  id: string;
  mode: string;
  duration_seconds: number;
  user_id: string;
  status: string;
  script_json: GeneratedScript | null;
  error_message: string | null;
  avatar_provider_video_job_id: string | null;
  render_attempts: number;
  render_started_at: string | null;
  created_at: string;
  long_form_confirmed_at: string | null;
  long_form_progress: unknown;
  long_form_production_plan: ProductionPlan | null;
  recorded_audio_path: string | null;
  supply_wait_started_at: string | null;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  // Red de seguridad: todo lo que sigue queda envuelto en un try/catch
  // único, mismo principio que en script/route.ts — cualquier fallo
  // inesperado (no solo el del worker) debe devolver JSON válido, nunca
  // un cuerpo vacío que el cliente no pueda parsear. Esto fue precisamente
  // lo que pasó en producción: un fallo al cargar el módulo del worker
  // (ver el comentario en src/lib/worker/inline.ts) ocurría fuera de
  // cualquier try/catch existente y tumbaba la función entera.
  try {
    const service = createServiceClient();

    // postgrest-js no atrapa un fallo de red/conexión propio — lo propaga
    // como excepción cruda en vez de devolverla en `error` (a diferencia de
    // un error HTTP normal de Postgrest, que sí llega como `{ error }`).
    // Sin este try/catch, esa excepción caía en el catch-all de abajo y se
    // clasificaba como el mismo mensaje genérico que cualquier otro fallo
    // — indistinguible de un problema del worker de GitHub Actions.
    let videoRequest: VideoRequestRow;
    try {
      const { data, error: fetchError } = await service
        .from("video_requests")
        .select("id, mode, duration_seconds, user_id, status, script_json, render_attempts, render_started_at, created_at, error_message, avatar_provider_video_job_id, long_form_confirmed_at, long_form_progress, long_form_production_plan, recorded_audio_path, supply_wait_started_at")
        .eq("id", id)
        .single<VideoRequestRow>();

      if (fetchError || !data) {
        return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
      }
      videoRequest = data;
    } catch (error) {
      throw new RenderStageError("fetch_request", error);
    }
    if (videoRequest.user_id !== user.id) {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }
    // QA blocker real (2026-09-25): esta ruta bloqueaba avatar con dos
    // gates heredados de la prueba privada P2/D-ID, ninguno de los dos
    // parte del producto self-service final:
    //  1. Un mensaje de "intento autorizado" ya usado — un límite de UN
    //     solo intento por solicitud, distinto (y más estricto) del límite
    //     genérico de reintentos que ya aplica a Reel/Avatar por igual
    //     (evaluateRenderStart, MAX_RENDER_ATTEMPTS=3, más abajo). Un
    //     usuario autorizado debe poder reintentar un render fallido
    //     exactamente igual que en Reel — eliminado, sin reemplazo: la
    //     protección real sigue siendo evaluateRenderStart() + el UPDATE
    //     condicional de más abajo.
    //  2. `!avatarModeEnabled || !canPrepareAvatar(user)` — el mismo bug
    //     de flag global que se corrigió en dashboard/new/actions.ts y
    //     page.tsx: con AVATAR_MODE_ENABLED apagado en producción, esa
    //     condición bloqueaba a CUALQUIER cuenta, incluida la beta
    //     autorizada. Se corrige al mismo patrón de acceso efectivo (flag
    //     global O acceso privado) — el acceso beta/allowlist (canPrepareAvatar)
    //     se preserva, solo deja de depender también del flag global.
    if (videoRequest.mode === "avatar" && !(getFeatureFlags().avatarModeEnabled || canPrepareAvatar(user))) {
      return NextResponse.json({ error: "El modo avatar no está disponible para tu cuenta." }, { status: 403 });
    }
    if (!videoRequest.script_json) {
      return NextResponse.json(
        { error: "Todavía no hay un guion generado para esta solicitud" },
        { status: 409 },
      );
    }
    if (videoRequest.mode === "long_form" && isLongFormScriptJson(videoRequest.script_json)) {
      const editorialError = editorialApprovalError(videoRequest.script_json);
      if (editorialError) return NextResponse.json({ error: editorialError }, { status: 409 });
    }
    // RC mission "LONG FORM RC FINAL HARDENING" (sección 8/36): Long Form
    // ya no puede arrancar producción audiovisual paga directo desde
    // "script_ready" — primero exige una confirmación humana explícita
    // (POST /confirm-production, que fija long_form_confirmed_at de forma
    // atómica). Esto es ADICIONAL al gate global preexistente de
    // LONG_FORM_REAL_RUN_CONFIRM en mode.ts (ese sigue intacto, nunca se
    // reemplaza) — dos capas independientes, cualquiera de las dos basta
    // para bloquear un gasto no autorizado.
    if (videoRequest.mode === "long_form" && !videoRequest.long_form_confirmed_at) {
      return NextResponse.json(
        { error: "Todavía no se confirmó el plan de producción para este video." },
        { status: 409 },
      );
    }

    // Primera línea de defensa contra doble render (solicitud duplicada,
    // ya en proceso, colgada, o máximo de intentos alcanzado) — lógica
    // pura extraída a render-guard.ts para poder probarla sin Supabase.
    // La garantía real contra una carrera (doble clic, dos pestañas) es
    // el UPDATE condicional más abajo, que Postgres serializa por fila.
    const decision = evaluateRenderStart(videoRequest);
    if (!decision.allowed) {
      return NextResponse.json({ error: decision.error }, { status: decision.status });
    }
    // Avatar recovery (failed or stale attempt): only when the request + its paid ledger prove it is
    // safe — the same rule the history and review screens use to show the button. Checked BEFORE
    // any reservation or attempt is spent.
    if (videoRequest.mode === "avatar" && videoRequest.status !== "script_ready") {
      const recovery = await loadAvatarRecovery(service, id, { status: videoRequest.status, render_attempts: videoRequest.render_attempts,
        avatar_provider_video_job_id: videoRequest.avatar_provider_video_job_id, video_path: null });
      if (recovery.action === "none") return NextResponse.json({ error: recovery.message }, { status: 409 });
    }

    // Reject oversize Avatar narration before reserving supply, spending an attempt or dispatching.
    const durationError = avatarRenderDurationError({ ...videoRequest, script_json: videoRequest.script_json }, getFeatureFlags().maxAvatarDurationSeconds);
    if (durationError) return NextResponse.json({ error: durationError }, { status: 422 });

    let check: Awaited<ReturnType<typeof assertCanGenerate>>;
    try {
      check = await assertCanGenerate(service, user.id, videoRequest.mode, user);
    } catch (error) {
      throw new RenderStageError("check_subscription", error);
    }
    if (!check.allowed) {
      return NextResponse.json({ error: check.reason }, { status: 402 });
    }

    // Visual release gate of v4+ plans, BEFORE reserving anything or spending an attempt: the worker
    // would stop on it anyway (visual-release-preflight.ts), so a missing curation never burns an attempt.
    if (videoRequest.mode === "long_form" && videoRequest.long_form_production_plan && usesVisualIdentity(videoRequest.long_form_production_plan)
        && isLongFormScriptJson(videoRequest.script_json)) {
      const sj = videoRequest.script_json as unknown as { topic: string; beats: ProductionPlanBeatInput[] };
      const visual = await visualCheck(service, { requestId: id, plan: videoRequest.long_form_production_plan, beats: sj.beats, topic: sj.topic || "" });
      if (!visual.ready) return NextResponse.json({ error: visualBlockMessage(visual) }, { status: 409 });
    }

    // Before the reservation nothing ran or was held: the request is unchanged (same status and attempts).
    const nothingReserved: StartOutcome = { retry: "available", charge: "none_proven", status: videoRequest.status, attempts: videoRequest.render_attempts };
    // Resolved BEFORE reserving: a missing worker configuration must not leave a held reservation behind.
    let worker: ReturnType<typeof getRenderWorker>;
    try {
      worker = getRenderWorker();
    } catch (error) {
      const failure = preReservationFailure(error, nothingReserved);
      return NextResponse.json(failure.body, { status: failure.status });
    }
    try {
      const demands = jobSupplyDemands(videoRequest, videoRequest.mode === "long_form"
        ? videoRequest.long_form_production_plan?.providers.voice ?? "unconfigured"
        : getVoiceProvider().name);
      if (supplyGuardRequired()) {
        // Same readiness rule as the preflight: stale balances of THIS job's
        // providers are re-read (billing GET only) before the atomic reservation.
        const readiness = await ensureJobSupplyReady(service, demands);
        if (!readiness.ready) {
          // Actionable: which provider, how much is missing and what to top up (nothing was reserved or charged).
          const failing = readiness.providers.find((r) => !r.ok);
          const action = failing ? providerCheck(failing, demands.find((d) => d.provider === failing.provider)?.unit ?? "usd").action : null;
          return NextResponse.json({ error: action ? `${START_SUPPLY_UNAVAILABLE} ${action}` : START_SUPPLY_UNAVAILABLE, outcome: nothingReserved }, { status: 503, headers: { "Retry-After": "300" } });
        }
      }
      await reserveJobSupply(service, id, videoRequest.render_attempts + 1, demands);
    } catch (error) {
      // Nothing was reserved, queued or charged; the request is unchanged and can be started again.
      if (error instanceof SupplyUnavailableError) return NextResponse.json({ error: START_SUPPLY_UNAVAILABLE, outcome: nothingReserved }, { status: 503, headers: { "Retry-After": "300" } });
      throw error;
    }

    // Guarda de concurrencia: la transición a "processing" solo aplica si
    // el estado sigue siendo el que acabamos de leer. Si otra request
    // ganó la carrera (doble clic, dos pestañas), `updated` viene vacío y
    // avisamos en vez de disparar un segundo render para el mismo video.
    // El propio await también puede lanzar (ver comentario en
    // fetch_request más arriba) — igual se etiqueta como "mark_processing"
    // para distinguirlo de un error devuelto normalmente en `updateError`.
    let updated: { id: string }[] | null;
    let updateError: { message: string; code?: string } | null;
    try {
      const result = await service
        .from("video_requests")
        .update({
          supply_wait_started_at: null, supply_not_before: null,
          status: "processing",
          error_message: null,
          progress_stage: "queued",
          render_started_at: new Date().toISOString(),
          render_attempts: videoRequest.render_attempts + 1,
          render_worker: worker.name,
          // T-34 B3: same rule as the review page; the worker blocks before spending if it cannot honour it.
          director_requested: directorRenderAllowed(user, videoRequest),
        })
        .eq("id", id)
        .eq("status", videoRequest.status)
        .eq("render_attempts", videoRequest.render_attempts)
        .select("id");
      updated = result.data;
      updateError = result.error;
    } catch (error) {
      throw new RenderStageError("mark_processing", error);
    }

    if (updateError) {
      const diagnosticId = generateDiagnosticId();
      logRenderError("POST /render (actualizar a processing)", updateError, diagnosticId);
      return NextResponse.json(
        { error: `No se pudo iniciar el render. (Código: ${diagnosticId})` },
        { status: 500 },
      );
    }
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: "El estado cambió justo antes de iniciar el render. Intenta de nuevo." },
        { status: 409 },
      );
    }

    try {
      await worker.trigger({ requestId: id, renderAttempt: videoRequest.render_attempts + 1, mode: videoRequest.mode });
    } catch (error) {
      const diagnosticId = generateDiagnosticId();
      logRenderError(`POST /render (worker: ${worker.name})`, error, diagnosticId);
      const { message, action } = classifyRenderFailure(error, diagnosticId);
      // Zero charge is claimed only when this attempt provably never ran AND its reservation was released.
      const outcome: StartOutcome = { retry: action === "support" ? "support" : "available", charge: "unknown", status: "processing", attempts: videoRequest.render_attempts + 1 };

      // El mensaje ya clasificado del fallo del worker es lo único que
      // debe llegar al cliente — si esta actualización de estado (o la
      // propia llamada) falla también, se registra como un problema
      // aparte con el mismo diagnosticId, pero nunca debe reemplazar ni
      // perder el mensaje original ya calculado.
      try {
        const { data: failed, error: failUpdateError } = await service
          .from("video_requests")
          .update({ status: "failed", error_message: encodeStoredFailure(message, action), progress_stage: null })
          .eq("id", id)
          .eq("status", "processing")
          .eq("render_attempts", videoRequest.render_attempts + 1)
          .eq("progress_stage", "queued")
          .select("id");
        if (failUpdateError) {
          logRenderError("POST /render (restaurar estado a failed)", failUpdateError, diagnosticId);
        } else if (failed?.length === 1) {
          outcome.status = "failed";
          // The attempt provably never started (still queued, now failed): free its reservation.
          // Never on a lost CAS or an uncertain update: a concurrent winner shares the same reservation key.
          const released = await releaseUnusedJobSupply(service, id, videoRequest.render_attempts + 1).then(() => true, () => {
            logRenderError("POST /render (liberar reserva)", new Error("release unconfirmed"), diagnosticId);
            return false;
          });
          if (released) outcome.charge = "none_proven";
        }
      } catch (restoreError) {
        logRenderError(
          "POST /render (restaurar estado a failed, excepción)",
          restoreError,
          diagnosticId,
        );
      }

      return NextResponse.json({ error: message, outcome }, { status: 500 });
    }

    return NextResponse.json({ status: "processing", worker: worker.name });
  } catch (error) {
    const diagnosticId = generateDiagnosticId();
    logRenderError("POST /render (inesperado)", error, diagnosticId);
    return NextResponse.json({ error: classifyRenderError(error, diagnosticId) }, { status: 500 });
  }
}
