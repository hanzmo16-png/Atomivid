/**
 * Podcast 3.0 — adaptadores REALES. Estado: «real adapter (untested live)». Reutilizan el código existente:
 *  - Voz: synthesizeVoice (ElevenLabs, src/lib/ai/voice.ts), con la voz elegida por participante.
 *  - Avatar: heygenAvatarProvider (src/lib/providers/avatar/heygen.ts): foto/avatar + audio propio del turno
 *    (sin TTS de respaldo), tope de costo por clip; requiere URL HTTPS del audio (subida firmada a Storage).
 *  - Imágenes: ilustraciones de Recraft (fal.ai) con el proveedor existente (src/lib/providers/image/recraft.ts), un
 *    estilo por episodio (la primera imagen lo crea desde las referencias del estudio; las demás lo reutilizan).
 *  - Director visual: Anthropic (mismo cliente protegido por el libro de gastos) describe la imagen de cada turno y
 *    VERIFICA cada imagen mirándola (lote de miniaturas).
 *  - Recorte de personas: RobustVideoMatting (ONNX, CPU, sin coste) con scripts/podcast-3-0/matte.py.
 * Nunca se ejecutan en CI: las pruebas usan mocks.ts.
 */
import { writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { synthesizeVoice } from "@/lib/ai/voice";
import { recraftImageProvider, RECRAFT_USD_PER_IMAGE, RECRAFT_USD_STYLE_CREATION } from "@/lib/providers/image/recraft";
import { ffmpeg } from "./ffmpeg";
import type { Face } from "./studios";
import { getPricingConfig } from "@/lib/billing/pricing";
import { heygenAvatarProvider, estimateHeygenCost } from "@/lib/providers/avatar/heygen";
import { ProviderRejectedError as StudioRejected } from "./cost";
import type { AvatarProvider, ImageProvider, Matter, TtsProvider, TurnBrief, VisualDirector } from "./pipeline";

/** `rate`: tarifa de la estimación autorizada del episodio (si falta, la de la configuración). */
export function realTts(language: "es" | "en", rate = getPricingConfig().elevenLabsUsdPer1kChars): TtsProvider {
  return { name: "elevenlabs", label: "real adapter (untested live)", model: "eleven_multilingual_v2", usdFor: (n) => Math.ceil(n / 1000 * rate * 1e4) / 1e4,
    async synth(text, voiceId, dest) {
      try {
        const r = await synthesizeVoice(text, language, undefined, voiceId); await writeFile(dest, r.audioBuffer);
        return { actualUsd: Math.ceil(text.length / 1000 * rate * 1e4) / 1e4, words: r.words.map((w) => ({ text: w.text, start: w.startSeconds, end: w.endSeconds })) };
      }
      catch (e) { if ((e as Error).name === "ProviderRejectedError") throw new StudioRejected((e as Error).message); throw e; }
    } };
}

/** `publishAudio` sube el audio del turno y devuelve una URL HTTPS firmada de corta duración; `fetchStill` trae la foto del avatar. */
export function realAvatar(deps: { publishAudio: (file: string) => Promise<string>; fetchStill: (avatarRef: string, dest: string) => Promise<void>; checkStill?: (avatarRef: string) => Promise<boolean> }): AvatarProvider {
  return { name: "heygen", label: "real adapter (untested live)", usdFor: (s) => estimateHeygenCost(Math.max(1, s)),
    still: (ref, dest) => deps.fetchStill(ref, dest), checkStill: deps.checkStill,
    async render(ref, audioFile, seconds, dest, maxUsd) {
      if (!heygenAvatarProvider.isAvailable()) throw new StudioRejected("HeyGen no está configurado (HEYGEN_API_KEY); no se generó ni cobró nada.");
      const audioUrl = await deps.publishAudio(audioFile);
      const r = await heygenAvatarProvider.generateVideo({ providerAvatarId: ref, script: "", audioUrl, audioDurationSeconds: seconds, maxCostUsd: maxUsd });
      await writeFile(dest, r.buffer);
      return { actualUsd: r.costUsd ?? estimateHeygenCost(seconds) };
    } };
}

/**
 * Ilustraciones de Recraft para el estudio. `styleRefs` = URLs HTTPS (firmadas) de las imágenes de referencia del
 * estilo del podcast: la primera generación crea el estilo (+USD 0,005) y devuelve su style_id; las demás del episodio
 * lo reutilizan (estilo coherente). Sin FAL_KEY se rechaza ANTES de cualquier cargo (no se sustituye por otro banco).
 */
export function realRecraftImages(deps: { styleRefs: () => Promise<string[]>; styleId?: string | null }): ImageProvider {
  let styleId: string | undefined = deps.styleId ?? undefined;
  return { name: "recraft", label: "real adapter (untested live)", generateUsd: RECRAFT_USD_PER_IMAGE, styleUsd: RECRAFT_USD_STYLE_CREATION,
    async generate(req, dest) {
      if (!process.env.FAL_KEY?.trim()) throw new StudioRejected("Recraft no está configurado en el generador (FAL_KEY); no se generó ni cobró nada.");
      const style = styleId ? { styleId } : { referenceImageUrls: await deps.styleRefs() };
      try {
        const r = await recraftImageProvider.generateImage!({ prompt: req.prompt, negativePrompt: req.negative, aspectRatio: req.aspect, style, disableRetries: true, maxCostUsd: RECRAFT_USD_PER_IMAGE + RECRAFT_USD_STYLE_CREATION } as never);
        if (r.styleId) styleId = r.styleId;
        await writeFile(dest, r.buffer);
        return { actualUsd: r.costUsd ?? RECRAFT_USD_PER_IMAGE };
      } catch (e) {
        // Rechazo antes de aceptar el trabajo (sin cargo): se libera la reserva. El resto queda incierto (se concilia).
        const reason = (e as { reason?: string }).reason;
        if (reason === "not_configured" || reason === "invalid_request" || reason === "authentication_error" || reason === "quota_exceeded" || reason === "rate_limited") throw new StudioRejected((e as Error).message);
        throw e;
      }
    } };
}

/** Miniatura JPEG pequeña para la verificación (pocos tokens y una reserva baja en el libro de Anthropic). */
async function thumbnail(file: string): Promise<string> {
  const out = `${file}.verif.jpg`;
  await ffmpeg(["-y", "-v", "error", "-i", file, "-vf", "scale=384:-2", "-q:v", "5", "-frames:v", "1", out]);
  return (await readFile(out)).toString("base64");
}

/**
 * Director visual real (Anthropic, «real adapter (untested live)»): guion visual del episodio y verificación en lote.
 * Las llamadas pasan por supplyProtectedAnthropic (reserva y liquidación en el libro de gastos, sin reintentos del SDK).
 */
export function realDirector(ownerId: string, episodeId: string): VisualDirector {
  const call = async (content: unknown, maxTokens: number) => {
    const [{ default: Anthropic }, { supplyProtectedAnthropic, withSupplyContext }] = await Promise.all([import("@anthropic-ai/sdk"), import("@/lib/supply/anthropic")]);
    const model = process.env.ANTHROPIC_SCRIPT_MODEL || "claude-sonnet-5";
    const params = { model, max_tokens: maxTokens, messages: [{ role: "user" as const, content }], ...(model === "claude-sonnet-5" ? { thinking: { type: "disabled" as const } } : {}) };
    const client = new Anthropic();
    const res = await withSupplyContext(`podcast-studio:${ownerId}:${episodeId}`, () =>
      supplyProtectedAnthropic(params, () => client.messages.create(params as never, { maxRetries: 0 }) as unknown as Promise<{ usage?: { input_tokens: number; output_tokens: number }; content: { type: string; text?: string }[] }>));
    const p = getPricingConfig();
    const usd = res.usage ? (res.usage.input_tokens * p.scriptInputUsdPer1MTokens + res.usage.output_tokens * p.scriptOutputUsdPer1MTokens) / 1e6 : 0.03;
    return { text: res.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"), usd: Math.ceil(usd * 1e4) / 1e4 };
  };
  const json = <T,>(t: string): T => JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1)) as T;
  return { label: "real adapter (untested live)", briefUsd: 0.04, verifyUsd: 0.002, verifyBatchUsd: 0.01,
    async brief(input) {
      const prompt = [
        `Eres director de arte de un podcast documental sobre «${input.topic || input.title}».`,
        "Para cada intervención, describe UNA ilustración que muestre su contenido concreto (lugares, objetos, personas de la época, fenómenos), coherente con el tema.",
        "Prohibido: texto o letreros en la imagen, objetos modernos ajenos (aviones, coches, teléfonos), decoraciones festivas, ropa de catálogo, productos.",
        "Si la intervención es abstracta (opinión, saludo), muestra el escenario o el objeto central del tema que mejor la acompañe.",
        "Responde SOLO un arreglo JSON: [{\"turn_id\": \"T001\", \"prompt\": \"descripción en inglés para el generador, 25-45 palabras, estilo documental cinematográfico\", \"subject\": \"en español, 3-8 palabras: qué debe verse\", \"recreation\": true si es una reconstrucción de una escena histórica o especulativa}].",
        "Intervenciones:",
        ...input.turns.map((t) => `${t.id}: ${t.text.slice(0, 600)}`),
      ].join("\n");
      const r = await call(prompt, 4000);
      const list = json<TurnBrief[]>(r.text).filter((b) => b && typeof b.turn_id === "string" && typeof b.prompt === "string")
        .map((b) => ({ turn_id: b.turn_id, prompt: b.prompt.slice(0, 600), subject: String(b.subject ?? "").slice(0, 120), recreation: b.recreation === true }));
      return { briefs: list, actualUsd: r.usd };
    },
    async verify(items, topic) {
      const content: unknown[] = [{ type: "text", text: `Verifica ilustraciones de un podcast sobre «${topic}». Para CADA imagen numerada, mira la imagen (no supongas por la descripción) y decide si muestra lo pedido y es pertinente al tema. Recházala si muestra algo ajeno (aviones, huevos de Pascua, bicicletas, plantas de vivero, ropa, regalos, oficinas modernas…), texto legible inventado, o no se reconoce lo pedido. Responde SOLO un arreglo JSON en el mismo orden: [{"n": 1, "ok": true|false, "reason": "breve, en español"}].` }];
      for (const [i, it] of items.entries()) {
        content.push({ type: "text", text: `Imagen ${i + 1} — debe mostrar: ${it.brief.subject}` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await thumbnail(it.image) } });
      }
      const r = await call(content, 1500);
      const list = json<{ n?: number; ok?: unknown; reason?: unknown }[]>(r.text);
      return { verdicts: items.map((_, i) => { const v = list.find((x) => Number(x.n) === i + 1) ?? list[i]; return { ok: v?.ok === true, reason: String(v?.reason ?? "sin veredicto").slice(0, 160) }; }), actualUsd: r.usd };
    } };
}

/** Modelo de recorte (RobustVideoMatting mobilenetv3, ONNX, licencia GPL-3.0 del repositorio original; solo inferencia). */
export const RVM_MODEL = { url: "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx", sha256: "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828" };

/**
 * Recorte real de personas (sin coste): matte.py con el modelo verificado por su huella. `--extend` prolonga hombros y
 * brazos cortados por el encuadre del proveedor para que un primer plano no muestre un borde recto.
 */
export function realMatter(deps: { model: string; python?: string }): Matter {
  return async (input, outBase, still) => {
    const fg = `${outBase}-fg.${still ? "png" : "mp4"}`, alpha = `${outBase}-alfa.${still ? "png" : "mp4"}`;
    const args = ["scripts/podcast-3-0/matte.py", deps.model, input, fg, alpha, "--extend", "0.3", ...(still ? ["--still", "12"] : [])];
    const r = spawnSync(deps.python ?? "python3", args, { encoding: "utf8", maxBuffer: 1 << 20 });
    if (r.status !== 0) throw new Error(`RECORTE: ${(r.stderr ?? "").slice(-300)}`);
    const out = JSON.parse(String(r.stdout).trim().split("\n").pop() ?? "{}") as { w: number; h: number; face: Face | null };
    return { fg, alpha, w: out.w, h: out.h, face: out.face, still };
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
