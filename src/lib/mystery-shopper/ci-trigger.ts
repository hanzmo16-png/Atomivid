/**
 * Disparador para eventos verificables de GitHub o Vercel.
 * Solo acepta pruebas gratuitas. Es idempotente por id de ejecución.
 * No arranca un navegador por sí mismo: quien lo ejecuta es un workflow de GitHub Actions.
 */
export type CiEvent = {
  source: "github" | "vercel";
  executionId: string;
  sha: string;
  conclusion?: string;
  preview?: string;
  module?: string;
  missionId?: string;
  mode?: string;
  billable?: boolean;
};

export type CiDecision = {
  accept: boolean;
  executionId: string;
  missionId: string;
  reason: string;
};

const SHA = /^[0-9a-f]{7,40}$/;
const EXEC = /^[a-zA-Z0-9:_-]{8,160}$/;

export function acceptCiEvent(event: CiEvent, already: ReadonlySet<string>): CiDecision {
  const missionId = event.missionId || "audio-flannan";
  const refuse = (reason: string): CiDecision => ({ accept: false, executionId: event.executionId || "", missionId, reason });
  if (!EXEC.test(event.executionId || "")) return refuse("El id de ejecución no es verificable.");
  if (already.has(event.executionId)) return { accept: false, executionId: event.executionId, missionId, reason: "Ya se ejecutó este id. No se repite." };
  if (!SHA.test(event.sha || "")) return refuse("El SHA no es verificable.");
  if (event.mode === "real" || event.billable === true) return refuse("Nada facturable corre de forma automática.");
  if (event.mode && event.mode !== "fixture") return refuse("El único modo automático es el gratuito.");
  if (event.source === "github" && event.conclusion !== "success") return refuse("CI no está en success.");
  if (event.source === "vercel" && event.preview !== "READY") return refuse("El Preview no está READY.");
  if (event.source !== "github" && event.source !== "vercel") return refuse("Origen no reconocido.");
  return { accept: true, executionId: event.executionId, missionId, reason: "Evento gratuito aceptado. El navegador corre en GitHub Actions, no en Vercel serverless." };
}

export const RUNNER_NOTE = "Playwright no corre en las funciones serverless de Vercel. El recorrido gratuito lo ejecuta el workflow .github/workflows/mystery-shopper.yml (GitHub Actions, capa gratuita). Sin ese worker no hay continuidad del navegador.";
