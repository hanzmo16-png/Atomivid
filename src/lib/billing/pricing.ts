/**
 * Tarifas estimadas para calcular el costo aproximado por video. Estas NO
 * son las tarifas reales de tu cuenta (varían por plan/volumen) — son
 * valores por defecto públicos, razonables pero aproximados, usados solo
 * si no configuras el valor real vía variable de entorno.
 *
 * Cómo actualizarlas: define la env var correspondiente (ver `.env.example`)
 * con la tarifa vigente de tu plan real. Fuentes para verificarla:
 * - Guion (Claude/Anthropic): https://www.anthropic.com/pricing
 * - Voz (ElevenLabs): https://elevenlabs.io/pricing/api — depende de tu plan
 * - Footage (Pexels): gratis, sin costo por request
 * - Render (GitHub Actions): https://docs.github.com/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions
 * - Storage (Supabase): https://supabase.com/pricing
 * - Avatar (HeyGen): ver estimateHeygenCost() en providers/avatar/heygen.ts —
 *   tarifa observada directamente de la cuenta real, no una lista de precios.
 * - Música: la biblioteca curada (Pixabay Music/ElevenLabs Music, ver
 *   src/lib/providers/music/manifest.ts) es gratis de usar en cada video
 *   (el gasto ya se pagó una vez al generarla) bajo licencias de uso
 *   comercial — el default es $0. Solo tiene sentido configurar
 *   PRICING_MUSIC_USD_PER_TRACK si en el futuro se conecta un proveedor que
 *   cobre por reproducción (p. ej. Epidemic Sound); no lo actives sin una
 *   tarifa real.
 *
 * Auditoría 2026-09-21: los 3 defaults de abajo (guion, voz, render) traían
 * tarifas obsoletas — sobreestimaban el costo real ~30-80% cada uno.
 * Guion: $3/$15 por 1M tokens era la tarifa de Claude Sonnet 4.6; el
 * proyecto ya usa claude-sonnet-5 por defecto (ver SCRIPT_MODEL en
 * src/lib/ai/script.ts), cuya tarifa real es $2/$10. Voz: $0.18/1k
 * caracteres vs. los $0.10/1k documentados hoy para eleven_multilingual_v2
 * (el modelo que usa este proyecto, ver MODEL_ID en src/lib/ai/voice.ts) —
 * confirma tu tarifa exacta contra tu plan real de ElevenLabs, el overage
 * puede variar por tier. Render: GitHub bajó el runner Linux de $0.008 a
 * $0.006/min el 1 de enero de 2026. Corregidos abajo — bajan el costo
 * estimado por video normal (sin avatar), no lo suben.
 */

function rate(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getPricingConfig() {
  return {
    /** USD por 1,000 caracteres enviados a síntesis de voz (eleven_multilingual_v2). */
    elevenLabsUsdPer1kChars: rate("PRICING_ELEVENLABS_USD_PER_1K_CHARS", 0.1),
    /** USD por 1,000,000 de tokens de entrada del modelo de guion (claude-sonnet-5). */
    scriptInputUsdPer1MTokens: rate("PRICING_SCRIPT_INPUT_USD_PER_1M_TOKENS", 2),
    /** USD por 1,000,000 de tokens de salida del modelo de guion (claude-sonnet-5). */
    scriptOutputUsdPer1MTokens: rate("PRICING_SCRIPT_OUTPUT_USD_PER_1M_TOKENS", 10),
    /** USD por minuto de runner usado para renderizar (GitHub Actions Linux, desde 2026-01-01). */
    renderUsdPerMinute: rate("PRICING_RENDER_USD_PER_MINUTE", 0.006),
    /** USD por pista de música usada. 0 por defecto — la biblioteca curada actual es gratis. */
    musicUsdPerTrack: rate("PRICING_MUSIC_USD_PER_TRACK", 0),
  };
}

// Aproximación gruesa (no exacta): ~4 caracteres por token en inglés/español.
// Se usa solo para estimar costo cuando no tenemos el conteo real de tokens
// que devuelve la API de Anthropic (ver nota en src/lib/billing/usage.ts).
const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateTokensFromChars(inputChars: number, outputChars: number) {
  return {
    inputTokens: Math.ceil(inputChars / CHARS_PER_TOKEN_ESTIMATE),
    outputTokens: Math.ceil(outputChars / CHARS_PER_TOKEN_ESTIMATE),
  };
}

export function estimateCostUsd(usage: {
  script_estimated_input_tokens: number;
  script_estimated_output_tokens: number;
  voice_characters: number;
  render_ms: number | null;
  /** Si el video terminó usando una pista de música real (no el fallback "sin música"). */
  has_music_track?: boolean;
  /**
   * Costo ya calculado en dólares por la capa creativa nueva (imagen
   * generada, clips premium) — a diferencia de script/voz/render, estos
   * proveedores devuelven su propio costo por unidad (ver GenerativeAsset
   * en providers/types.ts), no hace falta estimarlo aquí a partir de
   * tokens/caracteres. 0 en cualquier video que no usó estas integraciones.
   */
  image_cost_usd?: number;
  premium_video_cost_usd?: number;
  avatar_cost_usd?: number;
}): number {
  const pricing = getPricingConfig();

  const scriptCost =
    (usage.script_estimated_input_tokens / 1_000_000) * pricing.scriptInputUsdPer1MTokens +
    (usage.script_estimated_output_tokens / 1_000_000) * pricing.scriptOutputUsdPer1MTokens;

  const voiceCost = (usage.voice_characters / 1000) * pricing.elevenLabsUsdPer1kChars;

  const renderMinutes = (usage.render_ms ?? 0) / 60_000;
  const renderCost = renderMinutes * pricing.renderUsdPerMinute;

  const musicCost = usage.has_music_track ? pricing.musicUsdPerTrack : 0;
  const imageCost = usage.image_cost_usd ?? 0;
  const premiumVideoCost = usage.premium_video_cost_usd ?? 0;
  const avatarCost = usage.avatar_cost_usd ?? 0;

  return Math.round((scriptCost + voiceCost + renderCost + musicCost + imageCost + premiumVideoCost + avatarCost) * 1e6) / 1e6;
}
