import { createHash } from "node:crypto";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { GeneratedScript } from "@/lib/providers/types";
import { createServiceClient } from "@/lib/supabase/service";
import { RECORDING_BUCKET, isOwnedRecordingPath } from "@/lib/video/avatar/recording";
import { avatarEntitlementPreview } from "@/lib/billing/quota";
import { ScriptReview } from "./ScriptReview";
import { DirectionPanel } from "./DirectionPanel";
import { loadAudiovisualState } from "@/lib/video/audiovisual/persistence";
import { directionForApprovedScript } from "@/lib/video/audiovisual/direction";
import { evaluateDirectionReadiness } from "@/lib/video/audiovisual/readiness";

type VideoRequestRow = {
  id: string;
  mode: string;
  topic: string;
  style: string;
  duration_seconds: number;
  status: string;
  render_attempts: number;
  avatar_provider_video_job_id: string | null;
  script_json: GeneratedScript | null;
  error_message: string | null;
  recorded_audio_path: string | null;
};

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data } = await supabase
    .from("video_requests")
    .select("id, mode, topic, style, duration_seconds, status, script_json, error_message, recorded_audio_path, render_attempts, avatar_provider_video_job_id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle<VideoRequestRow>();

  if (!data || !data.script_json) {
    redirect("/dashboard");
  }

  let audioPreview: string | undefined;
  if (data.recorded_audio_path && isOwnedRecordingPath(data.recorded_audio_path, user.id, data.id)) {
    const { data: signed } = await createServiceClient().storage.from(RECORDING_BUCKET)
      .createSignedUrl(data.recorded_audio_path, 600);
    audioPreview = signed?.signedUrl;
  }

  // QA blocker real (2026-09-25): "Generar video final" quedaba
  // visualmente habilitado para avatar aunque el plan del usuario no
  // incluyera avatar — el POST fallaba recién al pulsar. Se comprueba el
  // entitlement AQUÍ (comprobación ligera, sin la consulta de conteo
  // mensual — ver avatarEntitlementPreview) para deshabilitar el botón de
  // antemano; assertCanGenerate en render/route.ts sigue siendo la única
  // fuente de verdad que de verdad bloquea el envío server-side.
  let avatarEntitlementBlockedReason: string | undefined;
  if (data.mode === "avatar") {
    const preview = await avatarEntitlementPreview(createServiceClient(), user.id, user);
    if (preview.blocked) avatarEntitlementBlockedReason = preview.reason;
  }

  // Dirección audiovisual (solo Reels creados con el selector): lo que se
  // producirá con ESTE guion y cualquier problema detectable antes de gastar.
  let directionPanel: { selection: NonNullable<Awaited<ReturnType<typeof loadAudiovisualState>>["selection"]>; summary: string; issues: ReturnType<typeof evaluateDirectionReadiness>["issues"] } | null = null;
  if (data.mode === "visual") {
    const av = await loadAudiovisualState(createServiceClient(), data.id).catch(() => null);
    if (av?.selection) {
      const { direction } = directionForApprovedScript({ stored: av.direction, selection: av.selection, style: data.style, topic: data.topic, scenes: data.script_json.segments });
      const readiness = evaluateDirectionReadiness({ profile: direction.profile, music: direction.music.id, sceneCount: data.script_json.segments.length });
      directionPanel = { selection: av.selection, summary: direction.summary, issues: readiness.issues };
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">{data.recorded_audio_path ? "Revisar grabación" : "Revisar guion"}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {data.topic} · {data.style} ·{" "}
        {data.recorded_audio_path
          ? `Duración: ${data.duration_seconds}s`
          : `${data.duration_seconds}s`}
      </p>
      {/* Contrato de duración (RC QA 2026-09-25): para "recording"/"tts_text"
          duration_seconds ya NO es el objetivo 30/60/90 del selector, sino la
          duración REAL del audio medida con ffprobe al crear la solicitud
          (measureNarrationSeconds, ver dashboard/new/actions.ts) — el mismo
          mecanismo, ya probado en producción, que preparation.ts (prueba
          privada D-ID) usa desde antes. Se muestra ese número aquí en vez de
          confiar en la duración que reporta el <audio> del navegador para el
          archivo crudo — reportes de QA reales mostraron un jugador HTML5
          marcando "0:20" para una grabación de ~45s; esta cifra es la
          verdad medida en servidor, no la metadata del contenedor de audio
          que el navegador interpreta. */}

      {directionPanel && (
        <DirectionPanel
          requestId={data.id}
          style={data.style}
          selection={directionPanel.selection}
          summary={directionPanel.summary}
          issues={directionPanel.issues}
          editable={data.status === "script_ready" || data.status === "failed"}
        />
      )}

      {audioPreview && <audio controls preload="metadata" src={audioPreview} className="my-4 w-full" aria-label="Tu grabación original" />}
      {/* Server Component: se evalúa una sola vez por request en el servidor
          (no hay re-render en el cliente que pueda desincronizarse), así que
          Date.now() aquí es seguro pese a la regla de pureza de React — mismo
          patrón ya usado en dashboard/page.tsx. */}
      <ScriptReview
        // eslint-disable-next-line react-hooks/purity -- ver comentario arriba
        diagnosticRetry={canPrepareAvatar(user) && Date.now() < Date.parse("2026-09-19T02:00:00Z")
          && createHash("sha256").update(data.id).digest("hex") === "24ad45b839f41c3c20e23d3a1b85e5d4e946fd66d1bead27865e4dbd506239b5"
          && data.status === "failed" && data.render_attempts === 1
          && data.avatar_provider_video_job_id === null && data.error_message === "did: D-ID respondió HTTP 403"}
        requestId={data.id}
        status={data.status}
        initialScript={data.script_json}
        errorMessage={data.error_message}
        usesRecording={Boolean(data.recorded_audio_path)}
        entitlementBlockedReason={avatarEntitlementBlockedReason}
      />
    </div>
  );
}
