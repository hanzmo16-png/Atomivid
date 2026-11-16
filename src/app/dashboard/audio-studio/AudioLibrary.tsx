import Link from "next/link";
import { STATUS_LABEL, voicePreset } from "@/lib/audio-studio/model";
import type { ProjectView } from "@/lib/audio-studio/service";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

const usd = (n: number) => `USD ${n.toFixed(2)}`;

/** Lista de episodios de audio de la cuenta. Sin medios que precargar: en 1.0 ningún episodio tiene audio generado. */
export function AudioLibrary({ projects, archived }: { projects: ProjectView[]; archived: boolean }) {
  if (!projects.length) {
    return <Card className="p-5 text-sm text-ink-muted" data-testid="audio-library-empty">{archived ? "No hay episodios archivados." : "Aún no tienes episodios de audio. Crea el primero arriba."}</Card>;
  }
  return (
    <ul className="space-y-3" data-testid="audio-library">
      {projects.map((p) => (
        <li key={p.id}>
          <Card className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/dashboard/audio-studio/${p.id}`} className="inline-flex min-h-11 items-center text-base font-medium text-ink hover:text-accent" data-testid="audio-library-item">
                  {p.title}
                </Link>
                <p className="text-xs text-ink-muted">
                  {p.voiceCount === 1 ? "1 voz" : "2 voces"} · {p.voices.map((v) => voicePreset(v)?.label.split(" — ")[0] ?? v).join(" y ")} · objetivo {p.targetMinutes} min · estimado {p.estimate.estimatedMinutes} min
                </p>
                <p className="text-xs text-ink-muted">Costo estimado {usd(p.estimate.estimatedUsd)} · tope {usd(p.budgetUsd)} · gastado {usd(p.spentUsd)}</p>
              </div>
              <Badge tone={p.status === "listo_para_autorizar" ? "success" : "neutral"}>{STATUS_LABEL[p.status]}</Badge>
            </div>
            <p className="mt-2 text-xs text-ink-faint">Audio: sin generar (requiere autorización de gasto).</p>
          </Card>
        </li>
      ))}
    </ul>
  );
}
