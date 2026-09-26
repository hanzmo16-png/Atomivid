import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { NewVideoForm } from "@/app/dashboard/new/NewVideoForm";
import { DirectionPanel } from "@/app/dashboard/review/[id]/DirectionPanel";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { profileAvailabilityByDuration } from "@/lib/video/audiovisual/readiness";
import { resolveDirection } from "@/lib/video/audiovisual/direction";
import { evaluateDirectionReadiness } from "@/lib/video/audiovisual/readiness";

/**
 * QA visual de la dirección audiovisual (móvil/escritorio) — solo `next dev`,
 * sin Supabase ni proveedores. El formulario usa la disponibilidad REAL de
 * este entorno (flags); el panel de revisión muestra dos casos: listo y
 * bloqueado (perfil ilustrado sin generación habilitada).
 */
async function noop() {
  "use server";
}

const MYSTERY = [
  { text: "Nadie sabe qué pasó aquella noche en el faro abandonado.", visualQuery: "old lighthouse", energy: "low" as const },
  { text: "El guardián desapareció y solo quedó un grito en la grabación.", visualQuery: "empty stairway", energy: "medium" as const },
  { text: "Entonces encontraron la puerta cerrada por dentro.", visualQuery: "locked door", energy: "high" as const },
];

export default function DevReelDirectionPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const flags = { ...getFeatureFlags(), imageGenerationEnabled: false };
  const ready = resolveDirection({ selection: { version: 1, profile: "horror_mystery" }, style: "Curiosidades", topic: "El faro", scenes: MYSTERY });
  const blocked = resolveDirection({ selection: { version: 1, profile: "comic" }, style: "Curiosidades", topic: "El faro", scenes: MYSTERY });
  const issuesFor = (d: typeof ready) => evaluateDirectionReadiness({ profile: d.profile, music: d.music.id, sceneCount: MYSTERY.length, flags, imageProvider: null, musicProviderSetting: "curated-library" }).issues;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <h1 className="text-2xl font-bold text-ink">Dirección audiovisual (QA)</h1>
      <Card className="p-6">
        <NewVideoForm
          action={noop}
          avatarModeEnabled={false}
          existingAvatars={[]}
          audiovisual={{ availabilityByDuration: profileAvailabilityByDuration([30, 60, 90], { flags, imageProvider: null }) }}
        />
      </Card>
      <div>
        <p className="text-sm text-ink-muted">Revisión del guion — lista para producir:</p>
        <DirectionPanel requestId="dev" style="Curiosidades" selection={ready.selection} summary={ready.summary} issues={issuesFor(ready)} editable />
      </div>
      <div>
        <p className="text-sm text-ink-muted">Revisión del guion — bloqueada antes de gastar:</p>
        <DirectionPanel requestId="dev" style="Curiosidades" selection={blocked.selection} summary={blocked.summary} issues={issuesFor(blocked)} editable />
      </div>
    </div>
  );
}
