import { createClient } from "@/lib/supabase/server";
import { STATUS_LABEL, isSubscriptionActive } from "@/lib/billing/subscription";
import { createCheckoutSession, createPortalSession } from "./actions";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

type SubscriptionRow = {
  status: string;
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
    .select("status, current_period_end, cancel_at_period_end")
    .eq("user_id", user?.id ?? "")
    .maybeSingle();

  const subscription = data as SubscriptionRow | null;
  const status = subscription?.status ?? "none";
  const active = isSubscriptionActive(status);

  return (
    <div className="mx-auto max-w-xl">
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

      <Card className="mt-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-ink-muted">Plan</p>
            <p className="text-lg font-semibold text-ink">Atomivid Pro</p>
          </div>
          <Badge tone={active ? "success" : "neutral"}>{STATUS_LABEL[status] ?? status}</Badge>
        </div>

        {subscription?.current_period_end && (
          <p className="mt-3 text-sm text-ink-muted">
            {subscription.cancel_at_period_end ? "Se cancela el " : "Se renueva el "}
            {new Date(subscription.current_period_end).toLocaleDateString("es-MX")}
          </p>
        )}

        <div className="mt-6">
          {active ? (
            <form action={createPortalSession}>
              <Button type="submit" variant="secondary">
                Administrar suscripción
              </Button>
            </form>
          ) : (
            <form action={createCheckoutSession}>
              <Button type="submit">Suscribirme</Button>
            </form>
          )}
        </div>
      </Card>
    </div>
  );
}
