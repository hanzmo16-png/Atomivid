import Link from "next/link";
import { audioProviderNote, downloadFileName, formatAudioDuration, languageLabel, libraryAudioState, STATUS_LABEL, voicePreset } from "@/lib/audio-studio/model";
import type { ProjectView } from "@/lib/audio-studio/service";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

const usd = (n: number) => `USD ${n.toFixed(2)}`;

/**
 * Lista de episodios de audio de la cuenta. El reproductor no descarga nada hasta pulsar reproducir (preload="none").
 * La insignia muestra el estado del AUDIO (listo, en curso, interrumpido, fallido); el del borrador va en el texto.
 */
export function AudioLibrary({ projects, archived, now }: { projects: ProjectView[]; archived: boolean; now: number }) {
  if (!projects.length) {
    return <Card className="p-5 text-sm text-ink-muted" data-testid="audio-library-empty">{archived ? "No hay episodios archivados." : "Aún no tienes episodios de audio. Crea el primero arriba."}</Card>;
  }
  return (
    <ul className="space-y-3" data-testid="audio-library">
      {projects.map((p) => {
        const state = libraryAudioState(p.generation, !!p.audio, now);
        return (
        <li key={p.id}>
          <Card className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/dashboard/audio-studio/${p.id}`} className="inline-flex min-h-11 items-center text-base font-medium text-ink hover:text-accent" data-testid="audio-library-item">
                  {p.title}
                </Link>
                <p className="text-xs text-ink-muted">
                  {languageLabel(p.language)} · {p.voiceCount === 1 ? "1 voz" : "2 voces"} · {p.voices.map((v) => voicePreset(v)?.label.split(" — ")[0] ?? v).join(" y ")} · objetivo {p.targetMinutes} min · estimado {p.estimate.estimatedMinutes} min
                </p>
                <p className="text-xs text-ink-muted">Costo estimado {usd(p.estimate.estimatedUsd)} · tope {usd(p.budgetUsd)} · gastado {usd(p.spentUsd)} · {STATUS_LABEL[p.status]}</p>
              </div>
              <Badge tone={state.tone}><span data-testid="audio-library-state">{state.label}</span></Badge>
            </div>
            {p.audio ? (
              <div className="mt-2 space-y-1" data-testid="audio-library-audio">
                <audio controls preload="none" className="w-full" src={`/api/audio-studio/projects/${p.id}/audio`} />
                <p className="text-xs text-ink-muted">
                  MP3 · {formatAudioDuration(p.audio.durationSeconds)} · {p.audio.lufs} LUFS
                  {audioProviderNote(p.audio.provider)}
                </p>
                <a href={`/api/audio-studio/projects/${p.id}/audio?descargar=1`} download={downloadFileName(p.title)} className="inline-flex min-h-11 items-center text-sm text-accent underline">Descargar MP3</a>
                {state.hint && <p className="text-xs text-ink-muted" data-testid="audio-library-hint">{state.hint}</p>}
              </div>
            ) : (
              <p className="mt-2 text-xs text-ink-muted" data-testid="audio-library-hint">{state.hint}</p>
            )}
          </Card>
        </li>
        );
      })}
    </ul>
  );
}
