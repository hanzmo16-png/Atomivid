import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { audioStudioUser, studioDeps } from "@/lib/audio-studio/server";
import { ensureSeed, listProjects } from "@/lib/audio-studio/service";
import { Alert } from "@/components/ui/Alert";
import { AudioLibrary } from "./AudioLibrary";
import { NewAudioEpisode } from "./NewAudioEpisode";

export const metadata: Metadata = { title: "Audio Podcast Studio" };
export const dynamic = "force-dynamic";

export default async function AudioStudioPage({ searchParams }: { searchParams: Promise<{ archivados?: string }> }) {
  const user = await audioStudioUser();
  if ("error" in user) {
    if (user.status === 401) redirect("/login");
    notFound();
  }
  const { archivados } = await searchParams;
  const deps = studioDeps();
  // El primer episodio del dueño queda cargado como proyecto editable (id estable: nunca se duplica).
  const seedError = user.owner
    ? await ensureSeed(deps, user.id).then(() => null, (e: unknown) => {
        console.error("[audio-studio] episodio inicial no cargado", e instanceof Error ? e.message.slice(0, 200) : "error");
        return "No se pudo cargar el episodio inicial.";
      })
    : null;
  const out = await listProjects(deps, user.id);
  const all = out.ok ? out.body.projects : [];
  const showArchived = archivados === "1";
  const shown = all.filter((p) => !!p.archivedAt === showArchived);
  const archivedCount = all.filter((p) => p.archivedAt).length;

  return (
    <div className="space-y-6" data-testid="audio-studio">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">Audio Podcast Studio 1.0</p>
        <h1 className="mt-1 text-2xl font-semibold text-ink">Podcast solo audio</h1>
        <p className="mt-1 text-sm text-ink-muted">Una o dos voces, guion editable, música de fondo y presupuesto visible. Nada se cobra mientras editas.</p>
      </div>
      {!out.ok && <Alert tone="danger">{out.body.error}</Alert>}
      {seedError && <Alert tone="warning">{seedError}</Alert>}
      <NewAudioEpisode />
      <section aria-labelledby="audio-library-title" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="audio-library-title" className="text-lg font-semibold text-ink">Biblioteca de audio</h2>
          <nav className="flex gap-1 text-sm" aria-label="Filtro de la biblioteca">
            <Link href="/dashboard/audio-studio" aria-current={!showArchived ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-md px-3 ${!showArchived ? "bg-surface-raised text-ink" : "text-ink-muted"}`}>Activos</Link>
            <Link href="/dashboard/audio-studio?archivados=1" aria-current={showArchived ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-md px-3 ${showArchived ? "bg-surface-raised text-ink" : "text-ink-muted"}`}>Archivados ({archivedCount})</Link>
          </nav>
        </div>
        <AudioLibrary projects={shown} archived={showArchived} />
      </section>
    </div>
  );
}
