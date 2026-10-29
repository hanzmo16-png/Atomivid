import { podcastV2Enabled } from "@/lib/podcast/server";
import { visibleVoices } from "@/lib/voices/private-voices";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { getPricingConfig } from "@/lib/billing/pricing";
import { listAccountVoices, VoicesUnavailableError, type AccountVoice } from "@/lib/podcast/voices";
import { PODCAST_MAX_CHARS, type PodcastEpisode } from "@/lib/podcast/episode";
import { NewEpisode } from "./NewEpisode";
import { PodcastWizard, type WizardAvatar, type WizardHost } from "./PodcastWizard";
import { HOST_CATALOG } from "@/lib/podcast/v3/catalog";
import { StudioEpisodeList } from "./StudioEpisodeList";
import { voiceAvailability } from "@/lib/podcast/v3/spec";
import { listStudioEpisodes } from "@/lib/podcast/v3/store";
import { studioFlagFor, studioGenerationEnabled, visualProviders } from "@/lib/podcast/v3/studio";
import { studioRecraftBlocker } from "@/lib/podcast/v3/readiness";
import { RECORDING_BUCKET } from "@/lib/video/avatar/recording";

const STATUS: Record<PodcastEpisode["status"], string> = { draft: "Borrador", generating: "Generando", ready: "Listo", failed: "Con error" };
const VIDEO: Record<string, string> = { scheduled: "programado", queued: "en cola", running: "en producción", ready: "entregado", failed: "con error", blocked: "detenido" };

export default async function PodcastPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!canAccessLongFormBeta(user)) notFound();
  const service = createServiceClient();
  const { data } = await service.from("podcast_episodes").select("id,title,status,source,duration_seconds,created_at,video_status,review_status").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);
  const episodes = (data ?? []) as Pick<PodcastEpisode, "id" | "title" | "status" | "source" | "duration_seconds" | "created_at" | "video_status" | "review_status">[];
  // Owner notices of the supervised productions (also sent through GitHub when the app is closed).
  const { data: noticeRows } = await service.from("production_notices").select("id,episode_id,kind,message,created_at,delivered_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(5);
  const notices = (noticeRows ?? []) as { id: string; episode_id: string; kind: "delivered" | "blocked" | "budget"; message: string; created_at: string; delivered_at: string | null }[];
  let voices: AccountVoice[] = [], voicesError: string | null = null;
  try { voices = visibleVoices(await listAccountVoices(), user); } catch (e) { voicesError = e instanceof VoicesUnavailableError ? e.customerMessage : "No se pudieron consultar las voces."; }

  // Estudio visible: PODCAST_V3_ENABLED=1, piloto del dueño o Vercel Preview (por defecto). La GENERACIÓN solo con
  // PODCAST_V3_ENABLED=1 o el piloto del dueño (exige la migración 140000): en Preview el flujo se recorre y estima, sin despachar.
  const flag = studioFlagFor(user);
  const v3Enabled = flag.enabled;
  const generationEnabled = studioGenerationEnabled(user);
  const previewNotice = flag.source === "preview" ? "Vista previa (Vercel Preview): el estudio se muestra activado solo aquí. Puedes recorrer los 10 pasos y ver costos; la generación real está desactivada hasta aplicar la migración y PODCAST_V3_ENABLED=1." : null;
  // Los episodios ya hechos se listan siempre (escuchar y descargar no genera ni cobra), aunque la generación esté apagada.
  const studioEpisodes = (await listStudioEpisodes(service, user.id)) ?? [];
  const { data: avatarRows } = await service.from("avatars").select("id,name,source_photo_path,source_deleted_at").eq("user_id", user.id).eq("status", "ready").order("created_at", { ascending: false }).limit(20);
  // Vista previa de cada avatar guardado: su foto en el almacenamiento privado (enlace firmado de 1 h), si aún existe.
  const avatars: WizardAvatar[] = await Promise.all(((avatarRows ?? []) as { id: string; name: string; source_photo_path: string | null; source_deleted_at: string | null }[]).map(async (a) => ({
    id: a.id, name: a.name,
    photoUrl: a.source_photo_path && !a.source_deleted_at ? (await service.storage.from(RECORDING_BUCKET).createSignedUrl(a.source_photo_path, 3600)).data?.signedUrl ?? null : null })));
  // Estado real de Recraft (política y saldo, solo lectura): el asistente muestra el motivo si hoy no puede producir.
  const recraftBlock = v3Enabled ? await studioRecraftBlocker(service) : null;
  const wizardVoices = voicesError ? [] : voiceAvailability(voices, user);
  // Catálogo de anfitriones: fotos, recortes y muestras en el almacenamiento privado → enlaces firmados (1 h).
  const sign = async (p: string) => (await service.storage.from("videos").createSignedUrl(p, 3600)).data?.signedUrl ?? null;
  const hosts: WizardHost[] = v3Enabled ? await Promise.all(HOST_CATALOG.map(async (h) => {
    const [photoUrl, cutoutUrl, stored] = await Promise.all([sign(h.photo), sign(h.cutout), h.sample.kind === "storage" ? sign(h.sample.path) : Promise.resolve(null)]);
    const sampleUrl = stored ?? voices.find((v) => v.voiceId === h.voiceId)?.previewUrl ?? null;
    return { id: h.id, name: h.name, role: h.role, description: h.description, voiceName: h.voiceName, photoUrl, sampleUrl,
      cutout: cutoutUrl ? { url: cutoutUrl, w: h.cutoutSize[0], h: h.cutoutSize[1], face: h.face } : null };
  })) : [];

  return (
    <div className="mx-auto w-full min-w-0 max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">Podcast</h1>
      <p className="mt-1 text-sm text-ink-muted">Crea tu episodio paso a paso: narración, un avatar presentador o una conversación entre dos. En cada episodio fijas el presupuesto, produces el video (ahora o programado) y lo revisas. Nada se publica sin tu aprobación.</p>
      <p className="mt-2 text-sm"><Link href="/dashboard/podcast/editor" className="text-accent underline">Ver entregas del editor externo</Link></p>
      {notices.length > 0 && (
        <section aria-label="Avisos" className="mt-4 rounded-lg border border-border p-3 text-sm">
          <h2 className="font-semibold text-ink">Avisos recientes</h2>
          <ul className="mt-1 space-y-1">
            {notices.map((n) => (
              <li key={n.id} className={n.kind === "delivered" ? "text-ink" : "text-danger"}>
                <Link href={`/dashboard/podcast/${n.episode_id}`} className="underline">{n.message}</Link>
                <span className="ml-1 text-ink-muted">· {new Date(n.created_at).toLocaleString("es-MX")}{n.delivered_at ? " · enviado a GitHub" : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {voicesError && <p className="mt-3 text-sm text-danger">{voicesError}</p>}
      <PodcastWizard voices={wizardVoices} avatars={avatars} v2Enabled={podcastV2Enabled()} v3Enabled={v3Enabled} generationEnabled={generationEnabled} providers={visualProviders(process.env, recraftBlock)} previewNotice={previewNotice} hosts={hosts} />
      <details className="mt-4 rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-ink">Formulario clásico (grabación propia, guion A/B)</summary>
        <NewEpisode voices={voices} voicesError={voicesError} usdPer1kChars={getPricingConfig().elevenLabsUsdPer1kChars} maxChars={PODCAST_MAX_CHARS} v2Enabled={podcastV2Enabled()} />
      </details>
      <h2 className="mt-8 text-lg font-semibold text-ink">Tus episodios</h2>
      <StudioEpisodeList episodes={studioEpisodes.map((e) => ({ id: e.id, title: e.title, status: e.status, mode: e.mode, cost_usd: e.cost_usd }))} />
      {episodes.length === 0 ? <p className="mt-2 text-sm text-ink-muted">Todavía no hay episodios.</p> : (
        <ul className="mt-2 grid gap-2">
          {episodes.map((e) => (
            <li key={e.id} className="rounded-lg border border-border p-3 text-sm">
              <Link href={`/dashboard/podcast/${e.id}`} className="font-medium text-ink underline">{e.title}</Link>
              <span className="ml-2 text-ink-muted">{STATUS[e.status]}{e.video_status && e.video_status !== "none" ? ` · video: ${VIDEO[e.video_status] ?? e.video_status}${e.video_status === "ready" ? (e.review_status === "approved" ? " (aprobado)" : e.review_status === "rejected" ? " (rechazado)" : " (por revisar)") : ""}` : ""} · {e.source === "upload" ? "grabación propia" : "voz sintética"}{e.duration_seconds ? ` · ${Math.round(Number(e.duration_seconds) / 60)} min` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
