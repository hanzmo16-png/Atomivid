import { createClient } from "@/lib/supabase/server";
import { STATUS_LABEL, isSubscriptionActive } from "@/lib/billing/subscription";
import { createCheckoutSession, createPortalSession } from "./actions";

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
      <h1 className="text-2xl font-bold text-gray-900">Facturación</h1>
      <p className="mt-1 text-sm text-gray-500">
        Se necesita una suscripción activa para generar videos.
      </p>

      {checkout === "success" && (
        <p className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          ¡Listo! Tu suscripción está siendo procesada.
        </p>
      )}
      {checkout === "canceled" && (
        <p className="mt-4 rounded-md bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
          El pago fue cancelado. Puedes intentarlo de nuevo cuando quieras.
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-500">Plan</p>
            <p className="text-lg font-semibold text-gray-900">Atomivid Pro</p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"
            }`}
          >
            {STATUS_LABEL[status] ?? status}
          </span>
        </div>

        {subscription?.current_period_end && (
          <p className="mt-3 text-sm text-gray-500">
            {subscription.cancel_at_period_end ? "Se cancela el " : "Se renueva el "}
            {new Date(subscription.current_period_end).toLocaleDateString("es-MX")}
          </p>
        )}

        <div className="mt-6">
          {active ? (
            <form action={createPortalSession}>
              <button
                type="submit"
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50"
              >
                Administrar suscripción
              </button>
            </form>
          ) : (
            <form action={createCheckoutSession}>
              <button
                type="submit"
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
              >
                Suscribirme
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
