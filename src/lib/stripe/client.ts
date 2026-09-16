import Stripe from "stripe";
import { MissingEnvVarError } from "@/lib/env-errors";

// Instanciado de forma perezosa: el SDK de Stripe valida la API key en el
// constructor y lanza un error si está vacía. Si se crea a nivel de módulo,
// Next.js la evalúa al recolectar datos de build y el build falla en
// entornos (como un primer deploy en Vercel) donde STRIPE_SECRET_KEY todavía
// no está configurada.
let cachedStripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!cachedStripe) {
    const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
    if (!secretKey) {
      throw new MissingEnvVarError("STRIPE_SECRET_KEY");
    }
    cachedStripe = new Stripe(secretKey);
  }
  return cachedStripe;
}
