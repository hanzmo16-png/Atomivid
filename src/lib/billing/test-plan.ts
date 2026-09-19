import { getStripe } from "@/lib/stripe/client";
import { displayPrice } from "./display-price";
export async function loadTestPlanPrice() {
  try {
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    const id = process.env.STRIPE_PRICE_ID?.trim();
    if (!key?.startsWith("sk_test_") || !id) return null;
    return displayPrice(await getStripe().prices.retrieve(id));
  } catch { return null; }
}
