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
 *  - Guion (Claude): CADA llamada real (primer borrador, correcciones de
 *    longitud y reintentos permitidos) es una operación propia del
 *    registro. Se reserva por llamada con el peor caso (tokens de entrada
 *    estimados con margen + max_tokens de salida) y se liquida con los
 *    tokens MEDIDOS del `usage` de la respuesta × tarifa registrada
 *    (pricing.ts) → provider_usage; sin `usage`, por la reserva (estimated).
 *  - Stock (Pexels/Pixabay), música curada y render: sin costo por llamada;
 *    no pasan por el registro.
 */
import { getPricingConfig, estimateTokensFromChars } from "@/lib/billing/pricing";
import { GenerativeProviderError } from "@/lib/providers/types";
import { fetchFailureOutcome, httpStatusOutcome } from "@/lib/providers/charge-outcome";
import { PaidLedger, type FailureClass, type PaidLedgerState, type PaidLedgerStore } from "./paid-ledger";
import { readJsonState, writeJsonState } from "./storage-state";
import type { SupabaseClient } from "@supabase/supabase-js";

export const IMAGE_RESERVE_USD = 0.07;
export const VOICE_RESERVE_MARGIN = 1.2;
/** Iguales a MAX_LENGTH_ATTEMPTS y SCRIPT_MAX_TOKENS de src/lib/ai/script.ts (una prueba lo verifica). */
export const SCRIPT_LENGTH_ATTEMPTS = 3;
export const SCRIPT_MAX_TOKENS_PER_CALL = 2000;
/** Caracteres de system + prompt de un guion de muestra con margen (el real ronda 3.500-4.500). */
export const SCRIPT_PROMPT_CHARS_ESTIMATE = 7000;

export function voiceCostUsd(characters: number): number {
  return (characters / 1000) * getPricingConfig().elevenLabsUsdPer1kChars;
}

export function voiceReserveUsd(characters: number): number {
  return voiceCostUsd(characters) * VOICE_RESERVE_MARGIN;
}

/**
 * Reserva de UNA llamada de guion antes de hacerla: la salida está acotada
 * por max_tokens; la entrada se sobreestima (1 token cada 2 caracteres, más
 * 3.000 tokens de margen para el esquema de salida estructurada y el
 * formato del mensaje).
 */
export function scriptCallReserveUsd(promptChars: number, maxTokens: number): number {
  const rates = getPricingConfig();
  const inputTokens = Math.ceil(promptChars / 2) + 3000;
  return (inputTokens / 1e6) * rates.scriptInputUsdPer1MTokens + (maxTokens / 1e6) * rates.scriptOutputUsdPer1MTokens;
}

/** Peor caso de una generación completa: tres llamadas (borrador + dos correcciones de longitud). */
export function scriptGenerationReserveUsd(): number {
  return SCRIPT_LENGTH_ATTEMPTS * scriptCallReserveUsd(SCRIPT_PROMPT_CHARS_ESTIMATE, SCRIPT_MAX_TOKENS_PER_CALL);
}

/**
 * Costo de una llamada desde los tokens MEDIDOS de la respuesta. Los tokens
 * de caché se cobran de forma conservadora (creación ×1,25; lectura a tarifa
 * completa de entrada).
 */
export function scriptUsageCostUsd(usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): number {
  const rates = getPricingConfig();
  const inputTokens = usage.input_tokens + 1.25 * (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return (inputTokens / 1e6) * rates.scriptInputUsdPer1MTokens + (usage.output_tokens / 1e6) * rates.scriptOutputUsdPer1MTokens;
}

export function scriptCostUsd(inputChars: number, outputChars: number): number {
  const rates = getPricingConfig();
  const { inputTokens, outputTokens } = estimateTokensFromChars(inputChars, outputChars);
  return (inputTokens / 1e6) * rates.scriptInputUsdPer1MTokens + (outputTokens / 1e6) * rates.scriptOutputUsdPer1MTokens;
}

/**
 * Imagen: costo cero conocido SOLO con evidencia (providers/charge-outcome.ts):
 * el proveedor declara `chargeOutcome` "not_sent" (no salió) o "rejected"
 * (rechazo explícito de la lista cerrada). Sin esa declaración, únicamente
 * los motivos que por construcción ocurren antes de llamar (no configurado,
 * presupuesto) son costo cero. Un error de red genérico, un 5xx, un timeout o
 * una respuesta rota → incierto.
 */
export function classifyImageFailure(err: unknown): FailureClass {
  if (err instanceof GenerativeProviderError) {
    if (err.chargeOutcome) return err.chargeOutcome === "uncertain" ? "uncertain" : "not_sent";
    return err.reason === "not_configured" || err.reason === "budget_exceeded" ? "not_sent" : "uncertain";
  }
  return "uncertain";
}

/**
 * Voz (ElevenLabs, lib/ai/voice.ts): falta de clave → no se llamó; «ElevenLabs
 * respondió <status>» → según la lista cerrada de rechazos (un 5xx o 408 es
 * incierto); excepción de fetch → solo costo cero si es inequívocamente previa
 * al envío (DNS, conexión rechazada, TLS). Lo demás → incierto.
 */
export function classifyVoiceFailure(err: unknown): FailureClass {
  const message = err instanceof Error ? err.message : String(err);
  if (/^Falta configurar ELEVENLABS_API_KEY/.test(message)) return "not_sent";
  const status = /^ElevenLabs respondió (\d{3})\b/.exec(message);
  if (status) return httpStatusOutcome(Number(status[1])) === "rejected" ? "not_sent" : "uncertain";
  return fetchFailureOutcome(err) === "not_sent" ? "not_sent" : "uncertain";
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
