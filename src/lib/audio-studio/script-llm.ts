/**
 * Modelo para el guion con IA de Audio Podcast Studio (script-ai.ts).
 *
 *  - Real: Anthropic a través del libro de gastos (supplyProtectedAnthropic): clave determinista por trabajo, paso e
 *    intento en el proyecto `audio-script:<cuenta>:<trabajo>`; repetir un paso reutiliza lo pagado, nunca cobra dos
 *    veces, y los topes global y del proveedor se aplican antes de llamar. Sin reintentos del SDK.
 *  - «fixture» (AUDIO_STUDIO_SCRIPT_AI=fixture, SOLO fuera de producción): escritura local determinista derivada del
 *    tema, las notas y la escaleta, para el arnés E2E y las pruebas (USD 0, sin red).
 *
 * Disponibilidad: real con ANTHROPIC_API_KEY, salvo AUDIO_STUDIO_SCRIPT_AI=0 (interruptor de apagado).
 */
import type { LlmStepFn, StepReplayFn } from "./script-ai";

export const AUDIO_SCRIPT_PROJECT_PREFIX = "audio-script:";
export const audioScriptProject = (ownerId: string, jobId: string) => `${AUDIO_SCRIPT_PROJECT_PREFIX}${ownerId}:${jobId}`;
const isProduction = (env: Record<string, string | undefined>) => !!env.VERCEL || env.NODE_ENV === "production";
const modelOf = (env: Record<string, string | undefined>) => env.ANTHROPIC_SCRIPT_MODEL || "claude-sonnet-5";

export type ScriptAiAvailability = { mode: "real" | "fixture"; step: (jobId: string) => LlmStepFn; replay: ((jobId: string) => StepReplayFn) | null } | { mode: "off"; reason: string };

export function scriptAiAvailability(ownerId: string, env: Record<string, string | undefined> = process.env): ScriptAiAvailability {
  if (env.AUDIO_STUDIO_SCRIPT_AI === "fixture" && !isProduction(env)) return { mode: "fixture", step: () => fixtureLlm(), replay: null };
  if (env.AUDIO_STUDIO_SCRIPT_AI === "0") return { mode: "off", reason: "La escritura del guion con IA está desactivada temporalmente. Puedes escribir o pegar tu guion." };
  if (!env.ANTHROPIC_API_KEY) return { mode: "off", reason: "La escritura del guion con IA no está disponible en este momento. Puedes escribir o pegar tu guion." };
  return { mode: "real", step: (jobId) => realStep(ownerId, jobId, env), replay: (jobId) => realReplay(ownerId, jobId, env) };
}

type AnthropicMessage = { stop_reason?: string | null; content?: { type: string; text?: string }[]; usage?: never };
const textOf = (r: AnthropicMessage) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

function realStep(ownerId: string, jobId: string, env: Record<string, string | undefined>): LlmStepFn {
  return async (prompt, o) => {
    const [{ default: Anthropic }, { supplyProtectedAnthropic, withSupplyStepContext }] = await Promise.all([import("@anthropic-ai/sdk"), import("@/lib/supply/anthropic")]);
    const model = modelOf(env);
    const params = { model, max_tokens: o.maxTokens, messages: [{ role: "user" as const, content: prompt }], ...(model === "claude-sonnet-5" ? { thinking: { type: "disabled" as const } } : {}) };
    const client = new Anthropic();
    const res = await withSupplyStepContext(audioScriptProject(ownerId, jobId), o.step, () =>
      supplyProtectedAnthropic(params, () => client.messages.create(params as never, { maxRetries: 0 }) as unknown as Promise<AnthropicMessage>));
    return { text: textOf(res), stopReason: res.stop_reason ?? null };
  };
}

function realReplay(ownerId: string, jobId: string, env: Record<string, string | undefined>): StepReplayFn {
  return async (step) => {
    const { replayPaidStep } = await import("@/lib/supply/anthropic");
    const res = await replayPaidStep<AnthropicMessage>(audioScriptProject(ownerId, jobId), step, modelOf(env));
    return res ? { text: textOf(res), stopReason: res.stop_reason ?? null } : null;
  };
}

/**
 * Escritura local determinista (sin IA): usa las palabras del tema, las notas y los puntos de la escaleta, con el
 * número de palabras pedido. Solo para pruebas y el arnés local; nunca en producción.
 */
export function fixtureLlm(): LlmStepFn {
  return async (prompt) => {
    const topic = (prompt.match(/Tema del episodio:\n«([^»]+)»/) ?? [])[1] ?? "el tema";
    if (/^Planifica/.test(prompt)) {
      const n = Number((prompt.match(/exactamente (\d+)/) ?? [])[1] ?? 1);
      const notes = (prompt.match(/OBLIGATORIAS[^\n]*\):\n«([^»]+)»/) ?? [])[1] ?? "";
      // Cada punto toma una frase de las notas de dirección (así el guion local refleja tema y notas).
      const sentences = notes.split(/(?<=[.!?])\s+/).map((x) => x.replace(/[.!?]+$/, "").trim()).filter(Boolean);
      const src = sentences.length ? sentences : [topic];
      return JSON.stringify({ titulo: topic, bloques: Array.from({ length: n }, (_, k) => ({
        titulo: `Parte ${k + 1} de ${topic}`,
        puntos: Array.from({ length: 4 }, (_, p) => `${src[(k * 4 + p) % src.length]} (${topic}, aspecto ${p + 1})`),
      })) });
    }
    const target = Number((prompt.match(/entre (\d+) y \d+ palabras/) ?? [])[1] ?? 150);
    const duo = /«Voz 1:» o «Voz 2:»/.test(prompt);
    const block = Number((prompt.match(/Escribe el bloque (\d+) de (\d+)/) ?? [])[1] ?? 1), of = Number((prompt.match(/Escribe el bloque \d+ de (\d+)/) ?? [])[1] ?? 1);
    const points = [...prompt.matchAll(/← ESTE BLOQUE\n((?:\s+- .+\n?)+)/g)].flatMap((m) => m[1].split("\n").map((l) => l.replace(/^\s+- /, "").trim()).filter(Boolean));
    const seed = `${points.join(" ")} ${topic}`.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let words = 0, i = 0, s = 0;
    if (block === 1) { lines.push(`${duo ? "Voz 1: " : ""}Empezamos un episodio dedicado a ${topic}.`); words += 6; }
    while (words < target) {
      const n = 22 + (i % 3) * 6;
      const chunk = Array.from({ length: n }, () => seed[s++ % seed.length]).join(" ");
      lines.push(`${duo ? `Voz ${(i % 2) + 1}: ` : ""}Sobre esto, ${chunk.toLowerCase()} con matices propios número ${block}${i}.`);
      words += n + 5; i++;
    }
    if (block === of) lines.push(`${duo ? `Voz ${(i % 2) + 1}: ` : ""}Así cerramos este recorrido por ${topic}. Hasta el próximo episodio.`);
    return { text: lines.join("\n"), stopReason: "end_turn" };
  };
}
