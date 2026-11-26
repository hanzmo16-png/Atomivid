/** Extra restrictions for the explicitly dispatched fresh 180-second journey. No budget authority. */
export function freshLongFormPreflight(env: NodeJS.ProcessEnv, minutes: number, runCap: number): string | null {
  if (env.MS_YOUTUBE_FRESH !== "1") return null;
  if (Object.entries(env).some(([key, value]) => value && /^MS_YOUTUBE_(RESUME_|EXISTING_|ALREADY_CONFIRMED)/.test(key)))
    return "El recorrido nuevo no admite preparación, financiación ni reintentos previos.";
  if (minutes !== 3 || !Number.isFinite(runCap) || runCap <= 0 || runCap > 2)
    return "El recorrido nuevo exige 180 segundos y un tope total de ejecución entre USD 0 y USD 2.";
  return null;
}

export function freshRequestId(configureHref: string): string | null {
  return /^\/dashboard\/long-form\/configure\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.exec(configureHref)?.[1] ?? null;
}
