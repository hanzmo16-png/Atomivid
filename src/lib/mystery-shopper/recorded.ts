import raw from "./recorded/journeys.json";
import type { Journey } from "./types";

/** Recorridos fixture grabados por el worker. Vacío hasta que el recorrido local los escribe. */
export function recordedJourneys(): Journey[] {
  const body = raw as { journeys?: Journey[] };
  return Array.isArray(body.journeys) ? body.journeys : [];
}
