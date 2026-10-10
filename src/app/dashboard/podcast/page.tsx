import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { getPricingConfig } from "@/lib/billing/pricing";
import { listAccountVoices, VoicesUnavailableError, type AccountVoice } from "@/lib/podcast/voices";
import { PODCAST_MAX_CHARS, type PodcastEpisode } from "@/lib/podcast/episode";
import { NewEpisode } from "./NewEpisode";

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
  try { voices = await listAccountVoices(); } catch (e) { voicesError = e instanceof VoicesUnavailableError ? e.customerMessage : "No se pudieron consultar las voces."; }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">Podcast</h1>
      <p className="mt-1 text-sm text-ink-muted">Pega tu guion y elige una voz de tu cuenta, o sube tu propia grabación. En cada episodio fijas el presupuesto, produces el video (ahora o programado) y lo revisas. Nada se publica sin tu aprobación.</p>
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
      <NewEpisode voices={voices} voicesError={voicesError} usdPer1kChars={getPricingConfig().elevenLabsUsdPer1kChars} maxChars={PODCAST_MAX_CHARS} />
      <h2 className="mt-8 text-lg font-semibold text-ink">Tus episodios</h2>
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
