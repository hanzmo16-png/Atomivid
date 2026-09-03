import Stripe from "stripe";

// Instanciado de forma perezosa: el SDK de Stripe valida la API key en el
// constructor y lanza un error si está vacía. Si se crea a nivel de módulo,
// Next.js la evalúa al recolectar datos de build y el build falla en
// entornos (como un primer deploy en Vercel) donde STRIPE_SECRET_KEY todavía
// no está configurada.
let cachedStripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!cachedStripe) {
    cachedStripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
  }
  return cachedStripe;
}
