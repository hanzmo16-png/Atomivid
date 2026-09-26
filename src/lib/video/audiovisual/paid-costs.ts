/**
 * Tarifas de RESERVA y clasificación de fallos por proveedor para el
 * registro de gasto (paid-ledger.ts). Qué es medido y qué es estimado:
 *
 *  - Imagen (OpenAI gpt-image-2): se liquida con el costo calculado del
 *    `usage` de la respuesta cuando viene (provider_usage); si no, con la
 *    estimación del proveedor (estimated). La RESERVA es conservadora
 *    (US$0,07, por encima de los US$0,0558 medidos en M3) para que el tope
 *    nunca se supere por una diferencia de tarifa.
 *  - Voz (ElevenLabs): la API no devuelve importe; se liquida con
 *    caracteres × tarifa registrada (billing/pricing.ts) → estimated. Los
 *    caracteres son exactos; la tarifa real depende del plan contratado.
 *    Reserva con +20 % de margen.
 *  - Guion (Claude): tokens estimados desde caracteres (pricing.ts) →
 *    estimated. Reserva por el peor caso de 3 intentos de longitud.
 *  - Stock (Pexels/Pixabay), música curada y render: sin costo por llamada;
 *    no pasan por el registro.
 */
import { getPricingConfig, estimateTokensFromChars } from "@/lib/billing/pricing";
import { GenerativeProviderError } from "@/lib/providers/types";
import { PaidLedger, type FailureClass, type PaidLedgerState, type PaidLedgerStore } from "./paid-ledger";
import { readJsonState, writeJsonState } from "./storage-state";
import type { SupabaseClient } from "@supabase/supabase-js";

export const IMAGE_RESERVE_USD = 0.07;
export const VOICE_RESERVE_MARGIN = 1.2;
export const SCRIPT_RESERVE_USD = 0.08;

export function voiceCostUsd(characters: number): number {
  return (characters / 1000) * getPricingConfig().elevenLabsUsdPer1kChars;
}

export function voiceReserveUsd(characters: number): number {
  return voiceCostUsd(characters) * VOICE_RESERVE_MARGIN;
}

export function scriptCostUsd(inputChars: number, outputChars: number): number {
  const rates = getPricingConfig();
  const { inputTokens, outputTokens } = estimateTokensFromChars(inputChars, outputChars);
  return (inputTokens / 1e6) * rates.scriptInputUsdPer1MTokens + (outputTokens / 1e6) * rates.scriptOutputUsdPer1MTokens;
}

/**
 * Imagen: costo cero conocido solo cuando la llamada no salió o el
 * proveedor respondió un error HTTP/moderación (openai.ts documenta que ahí
 * no se genera ni cobra). Timeout, respuesta rota u otro error → incierto.
 */
export function classifyImageFailure(err: unknown): FailureClass {
  if (err instanceof GenerativeProviderError) {
    return ["not_configured", "budget_exceeded", "upstream_error", "moderation_rejected"].includes(err.reason) ? "not_sent" : "uncertain";
  }
  return "uncertain";
}

/** Voz: «ElevenLabs respondió <status>» (error HTTP) o falta de clave → costo cero; lo demás (red, timeout, respuesta rota) → incierto. */
export function classifyVoiceFailure(err: unknown): FailureClass {
  const message = err instanceof Error ? err.message : String(err);
  return /^ElevenLabs respondió \d{3}/.test(message) || /Falta configurar ELEVENLABS_API_KEY/.test(message) ? "not_sent" : "uncertain";
}

export function ledgerPath(scopePrefix: string): string {
  return `${scopePrefix}/state/paid-ledger.json`;
}

export function storageLedgerStore(supabase: SupabaseClient, bucket: string, path: string): PaidLedgerStore {
  return {
    async load() {
      const state = await readJsonState<PaidLedgerState>(supabase, bucket, path, "el registro de gasto");
      return state.kind === "found" ? state.data : null;
    },
    async save(state) {
      await writeJsonState(supabase, bucket, path, state);
    },
  };
}

export async function openStorageLedger(
  supabase: SupabaseClient,
  bucket: string,
  scopePrefix: string,
  opts: { capUsd?: number; otherCommittedUsd?: number } = {},
): Promise<PaidLedger> {
  return PaidLedger.open(storageLedgerStore(supabase, bucket, ledgerPath(scopePrefix)), { scope: scopePrefix, ...opts });
}
