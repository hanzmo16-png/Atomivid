import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { AutoRefresh } from "../AutoRefresh";
import { listReadyUserVoices } from "@/lib/voices/user-voices";
import { downloadFileName, formatCount, formatDuration } from "@/lib/tts/segment";
import { charactersUsedThisMonth } from "@/lib/tts/requests";
import { TTS_BUCKET } from "@/lib/tts/run-tts-job";
import { resolveTtsLimits } from "@/lib/tts/limits";
import { MUSIC_CHOICES, findMusicBed } from "@/lib/tts/music-beds";
import { getVoiceCharacterQuota } from "@/lib/ai/voice";
import { TtsForm } from "./TtsForm";
import { createTextToSpeech, mixTextToSpeech, retryTextToSpeech } from "./actions";
import { canUseMyVoice } from "@/lib/voices/access";

type JobRow = {
  id: string;
  title: string;
  language: "es" | "en";
  voice_label: string;
  characters: number;
  segments_total: number | null;
  segments_done: number | null;
  status: "queued" | "processing" | "completed" | "failed";
  audio_path: string | null;
  duration_seconds: number | null;
  estimated_seconds: number | null;
  error_message: string | null;
  created_at: string;
  music_choice: "none" | "suspense" | "documentary" | null;
  music_track_id: string | null;
  mix_status: "pending" | "processing" | "completed" | "failed" | null;
  mix_path: string | null;
  mix_duration_seconds: number | null;
  mix_error: string | null;
};

type Links = { play: string; download: string };

async function signedLinks(bucket: ReturnType<ReturnType<typeof createServiceClient>["storage"]["from"]>, path: string, fileName: string): Promise<Links | null> {
  const [play, download] = await Promise.all([bucket.createSignedUrl(path, 3600), bucket.createSignedUrl(path, 3600, { download: fileName })]);
  return play.data && download.data ? { play: play.data.signedUrl, download: download.data.signedUrl } : null;
}

const STATUS: Record<JobRow["status"], { label: string; tone: BadgeTone }> = {
  queued: { label: "En cola", tone: "info" },
  processing: { label: "Generando", tone: "warning" },
  completed: { label: "Listo", tone: "success" },
  failed: { label: "Falló", tone: "danger" },
};

export default async function TextToSpeechPage({ searchParams }: { searchParams: Promise<{ error?: string; job?: string }> }) {
  const flags = getFeatureFlags();
  if (!flags.textToSpeechEnabled) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();
  const { error, job: createdJob } = await searchParams;

  // RLS: solo las piezas propias.
  const { data } = await supabase
    .from("tts_jobs")
    .select(
      "id, title, language, voice_label, characters, segments_total, segments_done, status, audio_path, duration_seconds, estimated_seconds, error_message, created_at, music_choice, music_track_id, mix_status, mix_path, mix_duration_seconds, mix_error",
    )
    .order("created_at", { ascending: false })
    .limit(30);
  const jobs = (data ?? []) as JobRow[];
  // Mismo cálculo que valida el servidor al crear (con RLS, solo las piezas propias).
  const used = await charactersUsedThisMonth(supabase, user.id).catch(() => 0);
  const limits = resolveTtsLimits(user, { maxCharsPerPiece: flags.ttsMaxCharsPerPiece, maxCharsPerUserMonth: flags.ttsMaxCharsPerUserMonth });
  const longPilot = limits.kind === "long_pilot";
  // Saldo real del servicio de voz (consulta gratuita), solo para el piloto de episodios largos.
  const quota = longPilot ? await getVoiceCharacterQuota().catch(() => null) : null;
  const provider = quota
    ? { remaining: quota.remaining, reserve: limits.providerReserveChars, resetsAt: quota.resetsAtUnix ? new Date(quota.resetsAtUnix * 1000).toISOString().slice(0, 10) : null }
    : null;
  const customVoices = canUseMyVoice(user) ? await listReadyUserVoices(supabase, user.id).catch(() => []) : [];

  // URLs firmadas solo para piezas que la consulta con RLS ya confirmó como propias.
  const service = createServiceClient();
  const bucket = service.storage.from(TTS_BUCKET);
  const narrationUrls = new Map<string, Links>();
  const mixUrls = new Map<string, Links>();
  await Promise.all(
    jobs.map(async (j) => {
      if (j.status === "completed" && j.audio_path) {
        const links = await signedLinks(bucket, j.audio_path, downloadFileName(j.title, "narracion"));
        if (links) narrationUrls.set(j.id, links);
      }
      if (j.mix_status === "completed" && j.mix_path) {
        const links = await signedLinks(bucket, j.mix_path, downloadFileName(j.title, "podcast-con-musica"));
        if (links) mixUrls.set(j.id, links);
      }
    }),
  );
  const active = jobs.some((j) => j.status === "queued" || j.status === "processing" || j.mix_status === "pending" || j.mix_status === "processing");

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <AutoRefresh active={active} />
      <div>
        <h1 className="text-2xl font-bold text-ink">Texto a voz</h1>
        <p className="mt-1 text-sm text-ink-muted">Convierte un texto en un audio MP3 narrado con una de las voces de Atomivid.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card className="p-5 sm:p-6">
        <TtsForm
          key={createdJob ?? "nuevo"}
          action={createTextToSpeech}
          maxCharsPerPiece={limits.maxCharsPerPiece}
          maxCharsPerUserMonth={limits.maxCharsPerUserMonth}
          usedThisMonth={used}
          longPilot={longPilot}
          provider={provider}
          musicEnabled={flags.ttsMusicEnabled}
          customVoices={customVoices}
          clientRequestId={randomUUID()}
        />
      </Card>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-ink">Historial</h2>
        {jobs.length === 0 ? (
          <EmptyState title="Todavía no tienes audios" description="Los audios que generes aparecerán aquí para escucharlos y descargarlos." />
        ) : (
          <ul className="space-y-3">
            {jobs.map((job) => {
              const narration = narrationUrls.get(job.id);
              const mix = mixUrls.get(job.id);
              const status = STATUS[job.status];
              const music = MUSIC_CHOICES.find((m) => m.value === (job.music_choice ?? "none"));
              const bed = findMusicBed(job.music_track_id);
              const mixBusy = job.mix_status === "pending" || job.mix_status === "processing";
              return (
                <li key={job.id}>
                  <Card className="space-y-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-ink">{job.title}</p>
                        <p className="text-xs text-ink-faint">
                          {job.voice_label} · {job.language === "en" ? "Inglés" : "Español"} · {formatCount(job.characters)} caracteres ·{" "}
                          {job.duration_seconds ? formatDuration(job.duration_seconds) : job.estimated_seconds ? `≈ ${formatDuration(job.estimated_seconds)} (estimación)` : ""}
                          {music && music.value !== "none" ? ` · ${music.label}` : ""}
                        </p>
                      </div>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                    {job.status === "processing" && job.segments_total ? (
                      <p className="text-xs text-ink-muted">
                        Fragmento {Math.min((job.segments_done ?? 0) + 1, job.segments_total)} de {job.segments_total}
                      </p>
                    ) : null}
                    {job.status === "completed" && narration && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-ink-muted">Narración</p>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <audio controls preload="none" src={narration.play} className="w-full" />
                          <a href={narration.download} className="shrink-0 text-sm font-medium text-accent hover:underline">
                            Descargar narración
                          </a>
                        </div>
                      </div>
                    )}
                    {job.status === "completed" && mix && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-ink-muted">
                          Podcast con música{bed ? ` · fondo «${bed.title}»` : ""}
                          {job.mix_duration_seconds ? ` · ${formatDuration(job.mix_duration_seconds)}` : ""}
                        </p>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <audio controls preload="none" src={mix.play} className="w-full" />
                          <a href={mix.download} className="shrink-0 text-sm font-medium text-accent hover:underline">
                            Descargar con música
                          </a>
                        </div>
                      </div>
                    )}
                    {job.status === "completed" && mixBusy && <p className="text-xs text-ink-muted">Preparando la versión con música… La narración ya está lista.</p>}
                    {job.status === "completed" && job.mix_status === "failed" && job.mix_error && <p className="text-sm text-danger">{job.mix_error}</p>}
                    {job.status === "completed" && flags.ttsMusicEnabled && !mixBusy && (
                      <form action={mixTextToSpeech} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="job_id" value={job.id} />
                        <label htmlFor={`mix-${job.id}`} className="text-xs text-ink-muted">
                          {job.mix_status === "completed" ? "Cambiar música:" : job.mix_status === "failed" ? "Reintentar con:" : "Añadir música:"}
                        </label>
                        <select id={`mix-${job.id}`} name="music" defaultValue={job.music_choice && job.music_choice !== "none" ? job.music_choice : "documentary"} className="rounded-md border border-border bg-surface px-2 py-1 text-sm">
                          {MUSIC_CHOICES.filter((m) => m.value !== "none").map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                        <Button type="submit" variant="secondary" size="sm">
                          {job.mix_status === "failed" ? "Preparar mezcla" : job.mix_status === "completed" ? "Volver a mezclar" : "Preparar mezcla"}
                        </Button>
                      </form>
                    )}
                    {job.status === "failed" && (
                      <div className="space-y-2">
                        {job.error_message && <p className="text-sm text-danger">{job.error_message}</p>}
                        <form action={retryTextToSpeech}>
                          <input type="hidden" name="job_id" value={job.id} />
                          <Button type="submit" variant="secondary" size="sm">
                            {(job.segments_done ?? 0) > 0 ? "Reanudar" : "Reintentar"}
                          </Button>
                        </form>
                      </div>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
