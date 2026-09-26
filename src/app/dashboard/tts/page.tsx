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
import { TtsForm } from "./TtsForm";
import { createTextToSpeech, retryTextToSpeech } from "./actions";
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
};

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
  const { error } = await searchParams;

  // RLS: solo las piezas propias.
  const { data } = await supabase
    .from("tts_jobs")
    .select("id, title, language, voice_label, characters, segments_total, segments_done, status, audio_path, duration_seconds, estimated_seconds, error_message, created_at")
    .order("created_at", { ascending: false })
    .limit(30);
  const jobs = (data ?? []) as JobRow[];
  // Mismo cálculo que valida el servidor al crear (con RLS, solo las piezas propias).
  const used = await charactersUsedThisMonth(supabase, user.id).catch(() => 0);
  const remaining = Math.max(0, flags.ttsMaxCharsPerUserMonth - used);
  const customVoices = canUseMyVoice(user) ? await listReadyUserVoices(supabase, user.id).catch(() => []) : [];

  // URLs firmadas solo para piezas que la consulta con RLS ya confirmó como propias.
  const service = createServiceClient();
  const urls = new Map<string, { play: string; download: string }>();
  await Promise.all(
    jobs
      .filter((j) => j.status === "completed" && j.audio_path)
      .map(async (j) => {
        const bucket = service.storage.from(TTS_BUCKET);
        const [play, download] = await Promise.all([
          bucket.createSignedUrl(j.audio_path!, 3600),
          bucket.createSignedUrl(j.audio_path!, 3600, { download: downloadFileName(j.title) }),
        ]);
        if (play.data && download.data) urls.set(j.id, { play: play.data.signedUrl, download: download.data.signedUrl });
      }),
  );
  const active = jobs.some((j) => j.status === "queued" || j.status === "processing");

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <AutoRefresh active={active} />
      <div>
        <h1 className="text-2xl font-bold text-ink">Texto a voz</h1>
        <p className="mt-1 text-sm text-ink-muted">Convierte un texto en un audio MP3 narrado con una de las voces de Atomivid.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card className="p-5 sm:p-6">
        <TtsForm action={createTextToSpeech} maxCharsPerPiece={flags.ttsMaxCharsPerPiece} remainingThisMonth={remaining} customVoices={customVoices} clientRequestId={randomUUID()} />
      </Card>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-ink">Historial</h2>
        {jobs.length === 0 ? (
          <EmptyState title="Todavía no tienes audios" description="Los audios que generes aparecerán aquí para escucharlos y descargarlos." />
        ) : (
          <ul className="space-y-3">
            {jobs.map((job) => {
              const url = urls.get(job.id);
              const status = STATUS[job.status];
              return (
                <li key={job.id}>
                  <Card className="space-y-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-ink">{job.title}</p>
                        <p className="text-xs text-ink-faint">
                          {job.voice_label} · {job.language === "en" ? "Inglés" : "Español"} · {formatCount(job.characters)} caracteres ·{" "}
                          {job.duration_seconds ? formatDuration(job.duration_seconds) : job.estimated_seconds ? `≈ ${formatDuration(job.estimated_seconds)}` : ""}
                        </p>
                      </div>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                    {job.status === "processing" && job.segments_total ? (
                      <p className="text-xs text-ink-muted">
                        Fragmento {Math.min((job.segments_done ?? 0) + 1, job.segments_total)} de {job.segments_total}
                      </p>
                    ) : null}
                    {job.status === "completed" && url && (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <audio controls preload="none" src={url.play} className="w-full" />
                        <a href={url.download} className="shrink-0 text-sm font-medium text-accent hover:underline">
                          Descargar MP3
                        </a>
                      </div>
                    )}
                    {job.status === "failed" && (
                      <div className="space-y-2">
                        {job.error_message && <p className="text-sm text-danger">{job.error_message}</p>}
                        <form action={retryTextToSpeech}>
                          <input type="hidden" name="job_id" value={job.id} />
                          <Button type="submit" variant="secondary" size="sm">
                            Reintentar
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
