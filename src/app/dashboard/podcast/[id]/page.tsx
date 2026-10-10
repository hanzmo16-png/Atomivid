import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { estimatePodcast, isStalledRun, isStalledVideo, podcastCapacity } from "@/lib/podcast/episode";
import { loadOwnedEpisode } from "@/lib/podcast/server";
import { episodeSpentUsd } from "@/lib/podcast/pilot-server";
import { EpisodeActions } from "./EpisodeActions";
import { VideoPanel } from "./VideoPanel";
import { remainingCostUsd, type VideoChecks } from "@/lib/podcast/pilot";

const USD = new Intl.NumberFormat("es-MX", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

export default async function PodcastEpisodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!canAccessLongFormBeta(user)) notFound();
  const service = createServiceClient();
  const episode = await loadOwnedEpisode(service, user.id, id);
  if (!episode) notFound();
  const estimate = episode.source === "tts" && episode.script ? estimatePodcast(episode.script) : null;
  const capacity = estimate && episode.status !== "ready" ? await podcastCapacity(service, estimate) : null;
  const storage = service.storage.from("videos");
  const safeName = episode.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 80) || "episodio";
  const playUrl = episode.status === "ready" && episode.audio_path ? (await storage.createSignedUrl(episode.audio_path, 3600)).data?.signedUrl ?? null : null;
  const downloadUrl = playUrl && episode.audio_path ? (await storage.createSignedUrl(episode.audio_path, 3600, { download: `${safeName}.m4a` })).data?.signedUrl ?? null : null;
  const stalled = isStalledRun(episode);
  const historicalUsd = await episodeSpentUsd(service, episode.id);
  const videoStatus = episode.video_status ?? "none";
  const VIDEO_TTL = 6 * 3600;
  const videoPlayUrl = videoStatus === "ready" && episode.video_path ? (await storage.createSignedUrl(episode.video_path, VIDEO_TTL)).data?.signedUrl ?? null : null;
  const videoDownloadUrl = videoPlayUrl && episode.video_path ? (await storage.createSignedUrl(episode.video_path, VIDEO_TTL, { download: `${safeName}.mp4` })).data?.signedUrl ?? null : null;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Link href="/dashboard/podcast" className="text-sm underline">← Podcast</Link>
      <h1 className="mt-2 text-2xl font-bold text-ink">{episode.title}</h1>
      <dl className="mt-3 grid grid-cols-[11rem_1fr] gap-y-1 text-sm">
        <dt className="text-ink-muted">Origen</dt><dd>{episode.source === "upload" ? "Grabación propia (sin clonación)" : `Voz sintética: ${episode.voice_name}`}</dd>
        <dt className="text-ink-muted">Idioma</dt><dd>{episode.language === "en" ? "Inglés" : "Español"}</dd>
        {estimate && <><dt className="text-ink-muted">Caracteres</dt><dd>{estimate.characters.toLocaleString("es-MX")} ({estimate.chunks} parte(s))</dd>
          <dt className="text-ink-muted">Costo estimado</dt><dd>{USD.format(estimate.usd)} ({USD.format(estimate.usdPer1kChars)} por 1 000 caracteres)</dd>
          <dt className="text-ink-muted">Duración estimada</dt><dd>≈ {Math.max(1, Math.round(estimate.estimatedSeconds / 60))} min</dd></>}
        {episode.cost_usd !== null && episode.status === "ready" && <><dt className="text-ink-muted">Costo registrado</dt><dd>{USD.format(Number(episode.cost_usd))}</dd></>}
        {episode.duration_seconds && episode.status === "ready" && <><dt className="text-ink-muted">Duración</dt><dd>{Math.floor(Number(episode.duration_seconds) / 60)} min {Math.round(Number(episode.duration_seconds) % 60)} s</dd></>}
      </dl>
      {episode.script && <details className="mt-3 rounded border border-border p-3 text-sm"><summary className="cursor-pointer">Ver guion</summary><p className="mt-2 whitespace-pre-wrap break-words">{episode.script}</p></details>}
      <EpisodeActions
        episodeId={episode.id}
        source={episode.source}
        status={episode.status}
        stalled={stalled}
        error={episode.error}
        capacity={capacity}
        playUrl={playUrl}
        downloadUrl={downloadUrl}
      />
      <VideoPanel
        episodeId={episode.id}
        status={videoStatus}
        stage={episode.video_stage ?? null}
        stalled={isStalledVideo(episode)}
        error={episode.video_error ?? null}
        canRequest={episode.source === "tts" ? Boolean(episode.script && episode.voice_id) : episode.status === "ready"}
        playUrl={videoPlayUrl}
        downloadUrl={videoDownloadUrl}
        sizeMb={episode.video_bytes ? Math.round(Number(episode.video_bytes) / 1_048_576) : null}
        minutes={episode.video_duration_seconds ? Math.round(Number(episode.video_duration_seconds) / 60) : null}
        remainingUsd={remainingCostUsd(episode)}
        budgetUsd={episode.budget_usd == null ? null : Number(episode.budget_usd)}
        scheduledAt={episode.scheduled_at ?? null}
        spentUsd={episode.cost_usd == null ? null : Number(episode.cost_usd)}
        historicalUsd={historicalUsd}
        seconds={episode.video_duration_seconds ? Number(episode.video_duration_seconds) : null}
        checks={(episode.video_checks as VideoChecks | null) ?? null}
        reviewStatus={episode.review_status ?? "pending"}
        reviewNote={episode.review_note ?? null}
        publishStatus={episode.publish_status ?? "held"}
      />
    </div>
  );
}
