import { generateScript, regenerateScene } from "@/lib/ai/script";
import type { ScriptProvider } from "../types";

// Reintentos ante fallos transitorios (red, rate limit, timeout) de Claude.
// No sustituye el contenido por el fixture si falla — un guion templado
// ("(fixture)", frases genéricas) no debe llegarle a un usuario real sin
// que lo sepa (misma política que ya aplica a la música fixture en el
// worker de render). Si tras los reintentos sigue fallando, el error se
// propaga tal cual y la solicitud queda en "failed" para reintentar
// manualmente — el sistema de fallback que ya existe (fixture solo cuando
// falta ANTHROPIC_API_KEY, en src/lib/providers/script/index.ts) sigue
// intacto.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [500, 1500];

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const delay = RETRY_DELAY_MS[attempt];
      if (delay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export const realScriptProvider: ScriptProvider = {
  name: "anthropic",
  generateScript(input) {
    return withRetry(() => generateScript(input));
  },
  regenerateScene(input) {
    return withRetry(() => regenerateScene(input));
  },
};
