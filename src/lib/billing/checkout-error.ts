import Stripe from "stripe";
import { MissingEnvVarError } from "@/lib/env-errors";

/**
 * Envuelve un error devuelto por una consulta de Supabase (el cliente no
 * lanza excepciones — devuelve { data, error } — así que este flujo debe
 * convertirlo explícitamente en algo que el try/catch de arriba pueda
 * clasificar en vez de ignorarlo silenciosamente como hacía el código
 * anterior).
 */
export class SupabaseQueryError extends Error {
  constructor(public readonly code: string | undefined) {
    super("Falló una consulta a Supabase en el flujo de facturación");
    this.name = "SupabaseQueryError";
  }
}

/** Stripe completó el checkout sin error pero no devolvió session.url. */
export class CheckoutUrlMissingError extends Error {
  constructor() {
    super("Stripe no devolvió una URL de checkout");
    this.name = "CheckoutUrlMissingError";
  }
}

/**
 * Mensaje seguro para mostrar en /dashboard/billing?error=... — nunca
 * incluye claves, tokens ni el contenido crudo de error.message de Stripe
 * (que en teoría es texto descriptivo seguro, pero no vale la pena
 * arriesgarlo). Para variable ausente sí incluye el nombre exacto de la
 * variable (no es secreto, es justo lo que hay que corregir) y para errores
 * de Stripe incluye su "type"/"code" — el código seguro del proveedor, que
 * tampoco es secreto — para que el problema sea accionable sin adivinar.
 */
export function classifyBillingError(error: unknown): string {
  if (error instanceof MissingEnvVarError) {
    return `Falta configurar ${error.varName} en el servidor. Contacta al soporte.`;
  }

  if (error instanceof Stripe.errors.StripeAuthenticationError) {
    return "La clave de Stripe configurada no es válida (StripeAuthenticationError). Contacta al soporte.";
  }

  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    const param = error.param ?? "";
    if (error.code === "resource_missing" && param.includes("price")) {
      return "El precio configurado no existe o no corresponde al modo de Stripe actual (resource_missing). Contacta al soporte.";
    }
    if (param.toLowerCase().includes("url")) {
      return "La URL de retorno configurada para el pago no es válida. Contacta al soporte.";
    }
    return `Stripe rechazó la solicitud de pago (${error.code ?? "invalid_request_error"}). Contacta al soporte.`;
  }

  if (error instanceof Stripe.errors.StripeError) {
    return `No se pudo conectar con Stripe (${error.type}). Intenta de nuevo en un momento.`;
  }

  if (error instanceof SupabaseQueryError) {
    return "No se pudo verificar tu cuenta de facturación. Intenta de nuevo en un momento.";
  }

  if (error instanceof CheckoutUrlMissingError) {
    return "Stripe no devolvió un enlace de pago. Intenta de nuevo en un momento.";
  }

  return "No se pudo iniciar el proceso de pago. Intenta de nuevo en un momento.";
}

/**
 * Log de servidor seguro: solo tipo/código estructural, nunca el mensaje
 * crudo del proveedor ni ningún dato de usuario (correo, ids de Stripe,
 * etc.) — cumple "registra tipo y código del error, nunca claves, tokens,
 * correos completos ni valores secretos".
 */
export function logBillingError(context: string, error: unknown): void {
  if (error instanceof MissingEnvVarError) {
    console.error(`[billing] ${context}: variable de entorno ausente`, {
      varName: error.varName,
    });
    return;
  }

  if (error instanceof Stripe.errors.StripeError) {
    console.error(`[billing] ${context}: error de Stripe`, {
      type: error.type,
      code: error.code,
      statusCode: error.statusCode,
    });
    return;
  }

  if (error instanceof SupabaseQueryError) {
    console.error(`[billing] ${context}: error de Supabase`, { code: error.code });
    return;
  }

  if (error instanceof Error) {
    console.error(`[billing] ${context}: ${error.name}`);
    return;
  }

  console.error(`[billing] ${context}: error desconocido`);
}
