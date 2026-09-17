import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { mondayFor } from "@/lib/growth/plan";
import { createClient } from "@/lib/supabase/server";
import { createGrowthPlan, editGrowthBrief, reviewGrowthBrief } from "./actions";

type BriefStatus = "draft" | "approved" | "rejected";
type GrowthBriefRow = {
  id: string;
  week_start: string;
  sequence: number;
  channel: "tiktok" | "instagram_reels" | "youtube_shorts";
  pillar: "product_proof" | "creator_education" | "build_in_public";
  objective: "awareness" | "activation" | "conversion";
  hook: string;
  topic: string;
  call_to_action: string;
  scheduled_for: string;
  status: BriefStatus;
};

const CHANNEL_LABEL = {
  tiktok: "TikTok",
  instagram_reels: "Instagram Reels",
  youtube_shorts: "YouTube Shorts",
};
const PILLAR_LABEL = {
  product_proof: "Demostración",
  creator_education: "Educación",
  build_in_public: "Construcción pública",
};
const STATUS_LABEL: Record<BriefStatus, string> = {
  draft: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
};
const STATUS_TONE: Record<BriefStatus, BadgeTone> = {
  draft: "warning",
  approved: "success",
  rejected: "danger",
};

function feedback(notice?: string, error?: string) {
  if (error === "storage-not-ready") return { tone: "warning" as const, text: "La bandeja está construida, pero falta aplicar la migración 0011 en Supabase." };
  if (error) return { tone: "danger" as const, text: "No pudimos completar la acción. Intenta nuevamente." };
  const notices: Record<string, string> = {
    "plan-created": "Plan semanal creado. Revisa cada propuesta antes de aprobarla.",
    "plan-exists": "Ya existe un plan para esta semana.",
    approved: "Propuesta aprobada.",
    rejected: "Propuesta rechazada.",
    updated: "Cambios guardados; la propuesta volvió a estado pendiente.",
  };
  return notice && notices[notice] ? { tone: "success" as const, text: notices[notice] } : null;
}

export default async function GrowthPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { notice, error: queryError } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("growth_briefs")
    .select("id, week_start, sequence, channel, pillar, objective, hook, topic, call_to_action, scheduled_for, status")
    .eq("user_id", user?.id ?? "")
    .order("scheduled_for", { ascending: true })
    .returns<GrowthBriefRow[]>();

  const briefs = data ?? [];
  const message = feedback(notice, queryError ?? (error ? "storage-not-ready" : undefined));
  const counts = briefs.reduce(
    (result, brief) => ({ ...result, [brief.status]: result[brief.status] + 1 }),
    { draft: 0, approved: 0, rejected: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-ink-muted">ATOMIVID Growth Engine</p>
          <h1 className="text-2xl font-bold text-ink">Bandeja de aprobación</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Revisa las propuestas antes de convertirlas en videos o publicaciones. Nada se publica automáticamente.
          </p>
        </div>
        <form action={createGrowthPlan}>
          <input type="hidden" name="weekStart" value={mondayFor()} />
          <Button type="submit">Crear plan semanal</Button>
        </form>
      </div>

      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4"><p className="text-sm text-ink-muted">Pendientes</p><p className="mt-1 text-2xl font-bold text-ink">{counts.draft}</p></Card>
        <Card className="p-4"><p className="text-sm text-ink-muted">Aprobadas</p><p className="mt-1 text-2xl font-bold text-success">{counts.approved}</p></Card>
        <Card className="p-4"><p className="text-sm text-ink-muted">Rechazadas</p><p className="mt-1 text-2xl font-bold text-danger">{counts.rejected}</p></Card>
      </div>

      {briefs.length === 0 ? (
        <Card className="p-8 text-center">
          <h2 className="font-semibold text-ink">No hay propuestas todavía</h2>
          <p className="mt-2 text-sm text-ink-muted">Crea el primer plan semanal para recibir 12 propuestas distribuidas entre los tres canales.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {briefs.map((brief) => (
            <Card key={brief.id} className="p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent">{CHANNEL_LABEL[brief.channel]}</Badge>
                <Badge>{PILLAR_LABEL[brief.pillar]}</Badge>
                <Badge tone={STATUS_TONE[brief.status]}>{STATUS_LABEL[brief.status]}</Badge>
                <span className="ml-auto text-xs text-ink-muted">
                  {new Date(brief.scheduled_for).toLocaleString("es-MX", { timeZone: "America/Cancun", dateStyle: "medium", timeStyle: "short" })}
                </span>
              </div>
              <p className="mt-4 text-lg font-semibold text-ink">{brief.hook}</p>
              <p className="mt-2 text-sm leading-6 text-ink-muted">{brief.topic}</p>
              <p className="mt-3 text-sm"><span className="font-medium text-ink">CTA:</span> <span className="text-ink-muted">{brief.call_to_action}</span></p>

              <div className="mt-5 flex flex-wrap gap-2">
                <form action={reviewGrowthBrief}>
                  <input type="hidden" name="id" value={brief.id} />
                  <input type="hidden" name="status" value="approved" />
                  <Button type="submit" size="sm" disabled={brief.status === "approved"}>Aprobar</Button>
                </form>
                <form action={reviewGrowthBrief}>
                  <input type="hidden" name="id" value={brief.id} />
                  <input type="hidden" name="status" value="rejected" />
                  <Button type="submit" size="sm" variant="danger" disabled={brief.status === "rejected"}>Rechazar</Button>
                </form>
              </div>

              <details className="mt-4 border-t border-border pt-4">
                <summary className="cursor-pointer text-sm font-medium text-accent">Editar propuesta</summary>
                <form action={editGrowthBrief} className="mt-4 space-y-3">
                  <input type="hidden" name="id" value={brief.id} />
                  <label className="block text-sm font-medium text-ink">Gancho
                    <textarea name="hook" defaultValue={brief.hook} rows={2} maxLength={280} required className="mt-1 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm" />
                  </label>
                  <label className="block text-sm font-medium text-ink">Tema
                    <textarea name="topic" defaultValue={brief.topic} rows={3} maxLength={500} required className="mt-1 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm" />
                  </label>
                  <label className="block text-sm font-medium text-ink">Llamada a la acción
                    <input name="callToAction" defaultValue={brief.call_to_action} maxLength={120} required className="mt-1 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm" />
                  </label>
                  <Button type="submit" size="sm" variant="secondary">Guardar cambios</Button>
                </form>
              </details>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
