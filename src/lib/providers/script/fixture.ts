import type { GeneratedScript, ScriptLanguage, ScriptProvider, ScriptScene } from "../types";
import { targetWordsFor } from "@/lib/video/script-pacing";

const TEMPLATES: Record<ScriptLanguage, Array<(topic: string) => string>> = {
  es: [
    (topic) => `Hoy hablamos de ${topic}.`,
    (topic) => `Esto es lo que nadie te cuenta sobre ${topic}.`,
    (topic) => `${topic} cambia todo cuando lo entiendes de verdad.`,
    (topic) => `La mayoría se rinde antes de ver resultados con ${topic}.`,
    (topic) => `Sigue avanzando en ${topic}, aunque nadie más lo note.`,
    (topic) => `El esfuerzo constante en ${topic} siempre deja huella.`,
    (topic) => `Con ${topic} no se trata de suerte, se trata de disciplina.`,
    (topic) => `Cada intento en ${topic} cuenta, incluso los que fallan.`,
    (topic) => `${topic} no es un evento, es un proceso.`,
    (topic) => `Lo difícil de hoy en ${topic} es la fuerza de mañana.`,
    (topic) => `Nadie llega lejos en ${topic} sin pagar el precio primero.`,
    (topic) => `Confía en el proceso de ${topic}, aunque no veas el final.`,
    (topic) => `El cambio real en ${topic} toma tiempo, no minutos.`,
    (topic) => `Sigue con ${topic} aunque sientas que nadie te ve.`,
    (topic) => `${topic} apenas comienza para ti.`,
  ],
  en: [
    (topic) => `Today we talk about ${topic}.`,
    (topic) => `Here's what nobody tells you about ${topic}.`,
    (topic) => `${topic} changes everything once you truly understand it.`,
    (topic) => `Most people quit before seeing results with ${topic}.`,
    (topic) => `Keep going with ${topic}, even when no one notices.`,
    (topic) => `Consistent effort in ${topic} always leaves a mark.`,
    (topic) => `${topic} isn't about luck, it's about discipline.`,
    (topic) => `Every attempt at ${topic} counts, even the failed ones.`,
    (topic) => `${topic} isn't an event, it's a process.`,
    (topic) => `Today's struggle with ${topic} is tomorrow's strength.`,
    (topic) => `Nobody gets far with ${topic} without paying the price first.`,
    (topic) => `Trust the process with ${topic}, even without seeing the end.`,
    (topic) => `Real change in ${topic} takes time, not minutes.`,
    (topic) => `Keep at ${topic} even when it feels like no one's watching.`,
    (topic) => `${topic} is just getting started for you.`,
  ],
};

const ENERGIES = ["medium", "high", "low"] as const;

function buildScene(
  topic: string,
  language: ScriptLanguage,
  templateIndex: number,
  wordsPerScene: number,
): ScriptScene {
  const templates = TEMPLATES[language];
  const template = templates[templateIndex % templates.length];
  let text = template(topic);

  // Rellena hasta acercarse a la duración objetivo por escena.
  while (text.split(/\s+/).length < wordsPerScene) {
    text += ` ${template(topic)}`;
  }
  // Synthetic timing must respect the requested word budget, even for long topics.
  text = text.split(/\s+/).slice(0, wordsPerScene).join(" ");

  const visualQuery = `${topic} motivation ${templateIndex + 1}`.slice(0, 60);

  return {
    text,
    visualQuery,
    // Conceptos deterministas y DISTINTOS entre sí (no solo el mismo
    // sufijo numérico) — así el fixture también ejercita la deduplicación
    // de footage-select.ts en pruebas/desarrollo sin depender de Claude.
    visualConcepts: [
      visualQuery,
      `${topic} effort scene ${templateIndex + 1}`.slice(0, 60),
      `${topic} progress moment ${templateIndex + 1}`.slice(0, 60),
    ],
    energy: ENERGIES[templateIndex % ENERGIES.length],
  };
}

// Proveedor determinístico (sin red): útil para probar el pipeline completo
// sin necesitar ANTHROPIC_API_KEY. No pretende igualar la calidad creativa
// del proveedor real — genera texto templado, suficiente para validar
// duración, escenas, sincronía y render.
export const fixtureScriptProvider: ScriptProvider = {
  name: "fixture",
  async generateScript({ topic, durationSeconds, language = "es" }): Promise<GeneratedScript> {
    const targetScenes = Math.max(3, Math.min(15, Math.round(durationSeconds / 5)));
    const targetWords = targetWordsFor(durationSeconds);
    const wordsPerScene = Math.max(4, Math.round(targetWords / targetScenes));

    const segments = Array.from({ length: targetScenes }, (_, i) =>
      buildScene(topic, language, i, wordsPerScene),
    );

    return {
      title: `${topic} (fixture, ${language})`,
      segments,
    };
  },
  async regenerateScene({ topic, script, sceneIndex }): Promise<ScriptScene> {
    const current = script.segments[sceneIndex];
    if (!current) {
      throw new Error(`No existe la escena ${sceneIndex}`);
    }
    const wordsPerScene = Math.max(4, current.text.split(/\s+/).filter(Boolean).length);
    // GeneratedScript no guarda el idioma original — el fixture no necesita
    // acertarlo (es solo para probar mecánica del pipeline), así que
    // reescribe en español por defecto.
    const language: ScriptLanguage = "es";
    // Desplaza medio ciclo de plantillas para que se note distinta a la actual.
    const templates = TEMPLATES[language];
    const variantIndex = sceneIndex + Math.ceil(templates.length / 2);
    return buildScene(topic, language, variantIndex, wordsPerScene);
  },
};
