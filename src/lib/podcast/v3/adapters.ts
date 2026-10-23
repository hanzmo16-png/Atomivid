/**
 * Podcast 3.0 — adaptadores REALES. Estado: «real adapter (untested live)». Reutilizan el código existente:
 *  - Voz: synthesizeVoice (ElevenLabs, src/lib/ai/voice.ts), con la voz elegida por participante.
 *  - Avatar: heygenAvatarProvider (src/lib/providers/avatar/heygen.ts): foto/avatar + audio propio del turno
 *    (sin TTS de respaldo), tope de costo por clip; requiere URL HTTPS del audio (subida firmada a Storage).
 *  - Imágenes: búsqueda de fotos de Pexels ya usada por el podcast (gratis).
 * Nunca se ejecutan en CI: las pruebas usan mocks.ts.
 */
import { writeFile, readFile } from "node:fs/promises";
import { synthesizeVoice } from "@/lib/ai/voice";
import { getPricingConfig } from "@/lib/billing/pricing";
import { heygenAvatarProvider, estimateHeygenCost } from "@/lib/providers/avatar/heygen";
import { ProviderRejectedError as StudioRejected } from "./cost";
import type { VisualAsset } from "./editorial";
import type { AvatarProvider, ImageProvider, TtsProvider } from "./pipeline";

export function realTts(language: "es" | "en"): TtsProvider {
  const rate = getPricingConfig().elevenLabsUsdPer1kChars;
  return { name: "elevenlabs", label: "real adapter (untested live)", model: "eleven_multilingual_v2", usdFor: (n) => Math.ceil(n / 1000 * rate * 1e4) / 1e4,
    async synth(text, voiceId, dest) {
      try { const r = await synthesizeVoice(text, language, undefined, voiceId); await writeFile(dest, r.audioBuffer); return { actualUsd: Math.ceil(text.length / 1000 * rate * 1e4) / 1e4 }; }
      catch (e) { if ((e as Error).name === "ProviderRejectedError") throw new StudioRejected((e as Error).message); throw e; }
    } };
}

/** `publishAudio` sube el audio del turno y devuelve una URL HTTPS firmada de corta duración; `fetchStill` trae la foto del avatar. */
export function realAvatar(deps: { publishAudio: (file: string) => Promise<string>; fetchStill: (avatarRef: string, dest: string) => Promise<void> }): AvatarProvider {
  return { name: "heygen", label: "real adapter (untested live)", usdFor: (s) => estimateHeygenCost(Math.max(1, s)),
    still: (ref, dest) => deps.fetchStill(ref, dest),
    async render(ref, audioFile, seconds, dest, maxUsd) {
      if (!heygenAvatarProvider.isAvailable()) throw new StudioRejected("HeyGen no está configurado (HEYGEN_API_KEY); no se generó ni cobró nada.");
      const audioUrl = await deps.publishAudio(audioFile);
      const r = await heygenAvatarProvider.generateVideo({ providerAvatarId: ref, script: "", audioUrl, audioDurationSeconds: seconds, maxCostUsd: maxUsd });
      await writeFile(dest, r.buffer);
      return { actualUsd: r.costUsd ?? estimateHeygenCost(seconds) };
    } };
}

export function realImages(deps: { searchPhotos: (q: string) => Promise<{ id: string | number; url: string; credit?: string }[]>; download: (url: string, dest: string) => Promise<void> }): ImageProvider {
  const urls = new Map<string, string>();
  return { name: "pexels", label: "real adapter (untested live)",
    async search(query) {
      const r = await deps.searchPhotos(query);
      return r.slice(0, 3).map((x) => { const id = `px-${x.id}`; urls.set(id, x.url); return { id, query, kind: "foto" as const, tags: query.split(" "), credit: x.credit } satisfies VisualAsset; });
    },
    async fetch(asset, dest) { const u = urls.get(asset.id); if (!u) throw new Error("Imagen no encontrada"); await deps.download(u, dest); await readFile(dest); },
    // Recreaciones (Recraft) NO conectadas en este PR: sin `recreate`, el planificador no las ofrece en real.
  };
}

/**
 * Generador conversacional por la ruta LLM existente: cliente Anthropic con supplyProtectedAnthropic (reserva en el
 * libro pi_paid_operations, sin reintentos del SDK). «real adapter (untested live)». Si falla, script.ts usa la plantilla.
 */
export function realLlm(ownerId: string, scopeKey: string): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const [{ default: Anthropic }, { supplyProtectedAnthropic, withSupplyContext }] = await Promise.all([import("@anthropic-ai/sdk"), import("@/lib/supply/anthropic")]);
    const model = process.env.ANTHROPIC_SCRIPT_MODEL || "claude-sonnet-5";
    const params = { model, max_tokens: 4000, messages: [{ role: "user" as const, content: prompt }], ...(model === "claude-sonnet-5" ? { thinking: { type: "disabled" as const } } : {}) };
    const client = new Anthropic();
    const res = await withSupplyContext(`podcast-studio:${ownerId}:${scopeKey}`, () =>
      supplyProtectedAnthropic(params, () => client.messages.create(params as never, { maxRetries: 0 }) as unknown as Promise<{ usage?: never; content: { type: string; text?: string }[] }>));
    return res.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  };
}
