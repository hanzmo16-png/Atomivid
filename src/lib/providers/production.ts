/** Vercel and the render worker must never substitute simulated content. */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1" || process.env.ATOMIVID_RUNTIME === "production";
}

export class ProviderConfigurationError extends Error {
  constructor(stage: string) {
    super(`Configuración incompleta del proveedor de ${stage}. No se generó contenido simulado. Contacta al soporte.`);
    this.name = "ProviderConfigurationError";
  }
}

export function requireRealProvider(stage: string, configured: boolean): void {
  if (isProductionRuntime() && !configured) throw new ProviderConfigurationError(stage);
}
