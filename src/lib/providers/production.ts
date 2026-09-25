/** Vercel and the render worker must never substitute simulated content. */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1" || process.env.ATOMIVID_RUNTIME === "production";
}

export class ProviderConfigurationError extends Error {
  constructor(
    stage: string,
    /**
     * Nombres de variables de entorno que explican el fallo — NUNCA sus
     * valores. Nunca forma parte de `.message` (lo que ve el usuario
     * sigue siendo el mismo texto genérico de siempre) — solo se usa
     * server-side (run-job.ts la registra junto al mismo diagnosticId que
     * ya lleva error_message) para que soporte pueda identificar
     * exactamente qué falta sin exponer nada al cliente.
     */
    public readonly missingEnvVars: string[] = [],
  ) {
    super(`Configuración incompleta del proveedor de ${stage}. No se generó contenido simulado. Contacta al soporte.`);
    this.name = "ProviderConfigurationError";
  }
}

export function requireRealProvider(stage: string, configured: boolean, missingEnvVars: string[] = []): void {
  if (isProductionRuntime() && !configured) throw new ProviderConfigurationError(stage, missingEnvVars);
}
