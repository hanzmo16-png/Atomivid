import type { displayPrice } from "@/lib/billing/display-price";
export function PriceSummary({ price }: { price: ReturnType<typeof displayPrice> }) {
  return <section aria-label="Precio del plan" className="my-4 space-y-2 rounded-lg border border-border p-4 text-sm">
    <p className="font-semibold">Pagos en modo de prueba: no se cobra dinero real. No introduzcas una tarjeta real.</p>
    {price ? <><p>Atomivid Pro: <strong>{price.amount} {price.period}</strong>. Precio de prueba; no es una oferta de venta real.</p><p>{price.taxes}</p><p>La suscripción de prueba se renueva automáticamente por ese periodo hasta cancelarla. Sin renovación tras finalizar el periodo cancelado.</p></>
      : <p>Precio no disponible para confirmar. La contratación permanece bloqueada hasta verificar el precio de prueba.</p>}
  </section>;
}
