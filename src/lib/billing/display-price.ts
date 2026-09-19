import type Stripe from "stripe";
export function displayPrice(price: Stripe.Price): { amount: string; period: string; taxes: string } | null {
  if (price.livemode || !price.active || price.type !== "recurring" || !price.recurring || price.unit_amount === null || price.billing_scheme !== "per_unit" || price.recurring.usage_type !== "licensed" || price.transform_quantity) return null;
  const currency = price.currency.toUpperCase();
  // Stripe uses minor units; Intl supplies the currency's exponent (JPY=0).
  const formatter = new Intl.NumberFormat("es-MX", { style: "currency", currency, currencyDisplay: "code" });
  const digits = ["ISK", "UGX"].includes(currency) ? 2 : (formatter.resolvedOptions().maximumFractionDigits ?? 2);
  const amount = formatter.format(price.unit_amount / 10 ** digits);
  const units: Record<string, string> = { day: "día(s)", week: "semana(s)", month: "mes(es)", year: "año(s)" };
  if (!units[price.recurring.interval]) return null;
  return { amount, period: `cada ${price.recurring.interval_count} ${units[price.recurring.interval]}`, taxes: price.tax_behavior === "inclusive" ? "Impuestos incluidos." : price.tax_behavior === "exclusive" ? "Impuestos no incluidos; el total se muestra antes de confirmar." : "El tratamiento de impuestos no está confirmado; revisa el total antes de confirmar." };
}
