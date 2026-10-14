import { InvalidEnvVarError, MissingEnvVarError } from "@/lib/env-errors";
import { LongFormRealModeNotConfirmedError, LongFormRealProviderMissingError } from "./long-form/mode";

/**
 * Customer-facing text never names internal configuration (environment variables, secrets, worker repo).
 * The full cause stays in the server log under the same diagnostic code.
 */
const INTERNAL_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

export function scrubInternalNames(text: string): string {
  return text.replace(INTERNAL_NAME, "[configuración interna]");
}

export const SERVICE_CONFIGURATION_MESSAGE =
  "La producción no pudo continuar por un problema de configuración del servicio, no por tu guion. " +
  "Tu solicitud y lo ya generado siguen guardados. Contacta al soporte con este código antes de volver a intentarlo.";

/** Errors that only an operator can fix (missing or invalid server configuration). Retrying will not help. */
export function isServiceConfigurationError(error: unknown): boolean {
  return error instanceof MissingEnvVarError || error instanceof InvalidEnvVarError
    || error instanceof LongFormRealModeNotConfirmedError || error instanceof LongFormRealProviderMissingError;
}
