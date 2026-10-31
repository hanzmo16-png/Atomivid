import { Card } from "@/components/ui/Card";
import { preProduceClarity, type ClarityCeiling, type PreProduceInput } from "@/lib/video/long-form/pre-produce-clarity";

const USD = new Intl.NumberFormat("es-MX", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function ceilingText(ceiling: ClarityCeiling): string {
  return "unavailable" in ceiling ? ceiling.unavailable : USD.format(ceiling.amount);
}

/** Una sola ficha, junto al botón de generar: video, duración, recursos y techo. */
export function PreProduceClarity({ input }: { input: PreProduceInput }) {
  const fact = preProduceClarity(input);
  return (
    <Card className="border-accent-border p-3 sm:p-4" data-testid="pre-produce-clarity" aria-label="Antes de generar">
      <h2 className="text-sm font-semibold text-ink">Antes de generar</h2>
      <dl className="mt-2 text-sm">
        <Fact label="Video" value={fact.video} />
        {fact.topicLine && <Fact label="Tema" value={fact.topicLine} />}
        <Fact label="Duración" value={fact.duration} />
        <Fact label="Recursos visuales" value={fact.visuals} />
        <Fact label={fact.ceiling.label} value={ceilingText(fact.ceiling)} />
      </dl>
      {fact.durationNote && <p className="mt-2 text-xs text-warning">{fact.durationNote}</p>}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-border py-1.5 last:border-b-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="break-words font-medium text-ink">{value}</dd>
    </div>
  );
}
