import { createClient } from "@/lib/supabase/server";
import { STATUS_LABEL, isSubscriptionActive } from "@/lib/billing/subscription";
import { PLAN_CONFIGS, PLAN_ORDER, getPlanByPriceId, type PlanConfig } from "@/lib/billing/plans";
import { createCheckoutSession, createPortalSession } from "./actions";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

type SubscriptionRow = {
  status: string;
  price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; error?: string }>;
}) {
  const { checkout, error } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data } = await supabase
    .from("subscriptions")
    .select("status, price_id, current_period_end, cancel_at_period_end")
    .eq("user_id", user?.id ?? "")
    .maybeSingle();

  const subscription = data as SubscriptionRow | null;
  const status = subscription?.status ?? "none";
  const active = isSubscriptionActive(status);
  // null cuando la suscripción es de un plan heredado o desconocido — ver
  // el mismo fallback aplicado en quota.ts (assertCanGenerate).
  const currentPlan = active ? getPlanByPriceId(subscription?.price_id) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-ink">Facturación</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Se necesita una suscripción activa para generar videos.
      </p>

      <div className="mt-4 space-y-3">
        {checkout === "success" && (
          <Alert tone="success">¡Listo! Tu suscripción está siendo procesada.</Alert>
        )}
        {checkout === "canceled" && (
          <Alert tone="warning">El pago fue cancelado. Puedes intentarlo de nuevo cuando quieras.</Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>

      {active && (
        <Card className="mt-6 overflow-hidden p-0">
          <div className="bg-atomivid-glow border-b border-border px-6 py-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Plan actual</p>
                <p className="text-xl font-bold text-ink">
                  {currentPlan ? `Atomivid ${currentPlan.name}` : "Atomivid"}
                </p>
              </div>
              <Badge tone="success">{STATUS_LABEL[status] ?? status}</Badge>
            </div>

            {subscription?.current_period_end && (
              <p className="mt-3 flex items-center gap-1.5 text-sm text-ink-muted">
                <CalendarIcon />
                {subscription.cancel_at_period_end ? "Se cancela el " : "Se renueva el "}
                {new Date(subscription.current_period_end).toLocaleDateString("es-MX")}
              </p>
            )}
          </div>

          <div className="px-6 py-5">
            {currentPlan && (
              <ul className="space-y-2.5">
                {currentPlan.includes.map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm text-ink-muted">
                    <CheckIcon />
                    {item}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-6">
              <form action={createPortalSession}>
                <Button type="submit" variant="secondary">
                  Administrar suscripción
                </Button>
              </form>
            </div>
          </div>
        </Card>
      )}

      {!active && (
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {PLAN_ORDER.map((id) => (
            <PlanCard key={id} plan={PLAN_CONFIGS[id]} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanCard({ plan }: { plan: PlanConfig }) {
  const createCheckoutSessionForPlan = createCheckoutSession.bind(null, plan.id);

  return (
    <Card className="flex flex-col overflow-hidden p-0">
      <div className="border-b border-border px-5 py-5">
        <p className="text-sm font-semibold uppercase tracking-wide text-ink-faint">{plan.name}</p>
        <p className="mt-1 text-3xl font-bold text-ink">
          ${plan.priceUsdPerMonth}
          <span className="text-sm font-normal text-ink-muted">/mes</span>
        </p>
      </div>

      <div className="flex flex-1 flex-col px-5 py-5">
        <ul className="flex-1 space-y-2.5">
          {plan.includes.map((item) => (
            <li key={item} className="flex items-start gap-2.5 text-sm text-ink-muted">
              <CheckIcon />
              {item}
            </li>
          ))}
        </ul>

        <form action={createCheckoutSessionForPlan} className="mt-6">
          <Button type="submit" className="w-full">
            Elegir {plan.name}
          </Button>
        </form>
      </div>
    </Card>
  );
}

function CheckIcon() {
  return (
    <svg className="mt-0.5 size-4 shrink-0 text-accent" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 010 1.4l-7.4 7.4a1 1 0 01-1.4 0L3.3 9.5a1 1 0 111.4-1.4l3.9 3.9 6.7-6.7a1 1 0 011.4 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
      <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 6.5h12M5 1.5v2M11 1.5v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
