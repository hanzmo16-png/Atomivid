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
import { StudioEpisodeCard } from "./StudioEpisodeList";
import { voiceAvailability } from "@/lib/podcast/v3/spec";
import { listStudioEpisodes } from "@/lib/podcast/v3/store";
import { AUTO_GROUPED, afterCursorFilter, fetchAllByCursor, libraryView, shownCount, VIEW_STEP } from "@/lib/podcast/library";
import { LibraryArchiveButton } from "./LibraryArchiveButton";
import { studioFlagFor, studioGenerationEnabled, visualProviders } from "@/lib/podcast/v3/studio";
import { studioRecraftBlocker } from "@/lib/podcast/v3/readiness";
import { RECORDING_BUCKET } from "@/lib/video/avatar/recording";

const STATUS: Record<PodcastEpisode["status"], string> = { draft: "Borrador", generating: "Generando", ready: "Listo", failed: "Con error" };
const VIDEO: Record<string, string> = { scheduled: "programado", queued: "en cola", running: "en producción", ready: "entregado", failed: "con error", blocked: "detenido" };

export default async function PodcastPage({ searchParams }: { searchParams: Promise<{ vista?: string; mostrar?: string }> }) {
  const sp = await searchParams;
  const view = sp.vista === "archivados" ? "archivados" : "principal";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!canAccessLongFormBeta(user)) notFound();
  const service = createServiceClient();
  // Biblioteca limpia: con la marca de archivo si su columna ya existe (migración 20261030170000); si no, como antes.
  // Todas las del dueño por páginas con cursor (updated_at, id): sin el tope invisible de 100 (T-20261031-1910, B3).
  const v2 = async (cols: string) => {
    let error = false;
    const out = await fetchAllByCursor<{ id: string; updated_at: string }>(async (after, size) => {
      let q = service.from("podcast_episodes").select(cols).eq("user_id", user.id);
      if (after) q = q.or(afterCursorFilter(after));
      const r = await q.order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(size);
      if (r.error) { error = true; return null; }
      return r.data as unknown as { id: string; updated_at: string }[];
    });
    return { data: out?.rows ?? null, error: error && !out?.rows.length };
  };
  const V2_COLS = "id,title,status,source,duration_seconds,created_at,updated_at,video_status,review_status";
  const withArchive = await v2(`${V2_COLS},archived_at`);
  const archiveReady = !withArchive.error;
  const { data } = archiveReady ? withArchive : await v2(V2_COLS);
  type V2Row = Pick<PodcastEpisode, "id" | "title" | "status" | "source" | "duration_seconds" | "created_at" | "video_status" | "review_status"> & { updated_at?: string | null; archived_at?: string | null };
  const allEpisodes = (data ?? []) as unknown as V2Row[];
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
  const allStudio = (await listStudioEpisodes(service, user.id)) ?? [];
  // Una sola secuencia (estudio + clásico): el orden en curso → terminado → borradores recientes es global, no por fuente.
  type Entry = ({ kind: "studio" } & (typeof allStudio)[number]) | ({ kind: "v2" } & V2Row);
  const all: Entry[] = [...allStudio.map((e) => ({ ...e, kind: "studio" as const })), ...allEpisodes.map((e) => ({ ...e, kind: "v2" as const }))];
  const fullView = libraryView(all, view);
  // De 50 en 50 («Ver más»): el orden de la vista es total (desempate por fuente e id), así que cada corte es estable.
  const shown = shownCount(sp.mostrar, fullView.length);
  const library = fullView.slice(0, shown);
  const moreHref = `/dashboard/podcast?${view === "archivados" ? "vista=archivados&" : ""}mostrar=${shown + VIEW_STEP}#episodios`;
  const archivedCount = libraryView(all, "archivados").length;
  const empty = library.length === 0;
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
      <h2 id="episodios" className="mt-8 text-lg font-semibold text-ink">Tus episodios</h2>
      <nav aria-label="Vista de episodios" className="mt-2 flex flex-wrap gap-2 text-sm" data-testid="biblioteca-vistas">
        <Link href="/dashboard/podcast#episodios" aria-current={view === "principal" ? "page" : undefined} className={`rounded px-3 py-1 ${view === "principal" ? "bg-accent text-accent-ink" : "border border-border text-ink"}`}>Mis episodios</Link>
        <Link href="/dashboard/podcast?vista=archivados#episodios" aria-current={view === "archivados" ? "page" : undefined} className={`rounded px-3 py-1 ${view === "archivados" ? "bg-accent text-accent-ink" : "border border-border text-ink"}`} data-testid="biblioteca-archivados">Archivados ({archivedCount})</Link>
      </nav>
      {view === "principal" && archivedCount > 0 && <p className="mt-2 text-xs text-ink-muted" data-testid="biblioteca-ocultos">Los episodios con error, los de prueba, los borradores de hace más de 7 días y lo que archives están en «Archivados» ({archivedCount}). No se borra nada.</p>}
      {view === "archivados" && <p className="mt-2 text-xs text-ink-muted">Aquí están lo que archivaste y, agrupados solos, los episodios con error, los de prueba y los borradores de hace más de 7 días. Sus archivos, enlaces y costos se conservan.</p>}
      {/* Sin la columna archived_at (migración 20261030170000 aún no aplicada) no se consulta para escribir ni se ofrece
          archivar: se dice por qué. La agrupación automática de lo viejo sigue funcionando sin escribir nada. */}
      {!archiveReady && <p className="mt-2 text-xs text-ink-muted" data-testid="biblioteca-archivo-bloqueado">Archivar a mano estará disponible cuando se aplique un cambio de base de datos pendiente de autorización. Mientras tanto, los episodios con error, los de prueba y los borradores de hace más de 7 días se agrupan solos en «Archivados», sin escribir nada.</p>}
      {!empty && (
        <ul className="mt-2 grid min-w-0 gap-2" data-testid="studio-episodes">
          {library.map((e) => e.kind === "studio" ? (
            <StudioEpisodeCard key={e.id} canArchive={archiveReady} episode={{ id: e.id, title: e.title, status: e.status, mode: e.mode, cost_usd: e.cost_usd, archived: e.bucket === "archivado", autoNote: AUTO_GROUPED[e.bucket] ?? null }} />
          ) : (
            <li key={e.id} className="min-w-0 rounded-lg border border-border p-3 text-sm" data-testid={`episodio-v2-${e.id}`}>
              <Link href={`/dashboard/podcast/${e.id}`} className="font-medium text-ink underline">{e.title}</Link>
              <span className="ml-2 text-ink-muted">{STATUS[e.status]}{e.video_status && e.video_status !== "none" ? ` · video: ${VIDEO[e.video_status] ?? e.video_status}${e.video_status === "ready" ? (e.review_status === "approved" ? " (aprobado)" : e.review_status === "rejected" ? " (rechazado)" : " (por revisar)") : ""}` : ""} · {e.source === "upload" ? "grabación propia" : "voz sintética"}{e.duration_seconds ? ` · ${Math.round(Number(e.duration_seconds) / 60)} min` : ""}</span>
              {AUTO_GROUPED[e.bucket] && <p className="mt-1 text-xs text-ink-muted">{AUTO_GROUPED[e.bucket]}</p>}
              {archiveReady && !AUTO_GROUPED[e.bucket] && e.bucket !== "en_curso" && <LibraryArchiveButton kind="v2" id={e.id} title={e.title} archived={e.bucket === "archivado"} />}
            </li>
          ))}
        </ul>
      )}
      {shown < fullView.length && <p className="mt-2 text-sm"><Link href={moreHref} scroll={false} className="text-accent underline" data-testid="biblioteca-ver-mas">Ver más ({fullView.length - shown} restantes)</Link></p>}
      {empty && <p className="mt-2 text-sm text-ink-muted" data-testid="biblioteca-vacia">{view === "archivados" ? "No tienes episodios archivados." : archivedCount > 0 ? "No tienes episodios en curso ni terminados. Crea uno arriba o revisa «Archivados»." : "Todavía no hay episodios. Crea el primero arriba."}</p>}
    </div>
  );
}
