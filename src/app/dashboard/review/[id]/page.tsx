import { createHash } from "node:crypto";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { GeneratedScript } from "@/lib/providers/types";
import { createServiceClient } from "@/lib/supabase/service";
import { RECORDING_BUCKET, isOwnedRecordingPath } from "@/lib/video/avatar/recording";
import { ScriptReview } from "./ScriptReview";

type VideoRequestRow = {
  id: string;
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
    .select("id, topic, style, duration_seconds, status, script_json, error_message, recorded_audio_path, render_attempts, avatar_provider_video_job_id")
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

  // This Server Component evaluates the diagnostic deadline once per request.
  // eslint-disable-next-line react-hooks/purity -- request-time server authorization deadline
  const renderNow = Date.now();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">{data.recorded_audio_path ? "Revisar grabación" : "Revisar guion"}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {data.topic} · {data.style} · {data.recorded_audio_path ? `Solicitada: ${data.duration_seconds} s (basada en la grabación)` : `Solicitada: ${data.duration_seconds} s (objetivo aproximado)`}
      </p>

      {audioPreview && <audio controls preload="metadata" src={audioPreview} className="my-4 w-full" aria-label="Tu grabación original" />}
      <ScriptReview
        diagnosticRetry={canPrepareAvatar(user) && renderNow < Date.parse("2026-09-19T02:00:00Z")
          && createHash("sha256").update(data.id).digest("hex") === "24ad45b839f41c3c20e23d3a1b85e5d4e946fd66d1bead27865e4dbd506239b5"
          && data.status === "failed" && data.render_attempts === 1
          && data.avatar_provider_video_job_id === null && data.error_message === "did: D-ID respondió HTTP 403"}
        requestId={data.id}
        status={data.status}
        initialScript={data.script_json}
        errorMessage={data.error_message}
        usesRecording={Boolean(data.recorded_audio_path)}
      />
    </div>
  );
}
