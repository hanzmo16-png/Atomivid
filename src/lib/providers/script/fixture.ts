import type { GeneratedScript, ScriptProvider } from "../types";

const WORDS_PER_SECOND = 2.6;

const TEMPLATES: Array<(topic: string) => string> = [
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
];

// Proveedor determinístico (sin red): útil para probar el pipeline completo
// sin necesitar ANTHROPIC_API_KEY. No pretende igualar la calidad creativa
// del proveedor real — genera texto templado, suficiente para validar
// duración, escenas, sincronía y render.
export const fixtureScriptProvider: ScriptProvider = {
  name: "fixture",
  async generateScript({ topic, durationSeconds }): Promise<GeneratedScript> {
    const targetScenes = Math.max(3, Math.min(15, Math.round(durationSeconds / 5)));
    const targetWords = Math.round(durationSeconds * WORDS_PER_SECOND);
    const wordsPerScene = Math.max(4, Math.round(targetWords / targetScenes));

    const segments = Array.from({ length: targetScenes }, (_, i) => {
      const template = TEMPLATES[i % TEMPLATES.length];
      let text = template(topic);

      // Rellena hasta acercarse a la duración objetivo por escena.
      while (text.split(/\s+/).length < wordsPerScene) {
        text += ` ${template(topic)}`;
      }

      return {
        text,
        visualQuery: `${topic} motivation ${i + 1}`.slice(0, 60),
      };
    });

    return {
      title: `${topic} (fixture)`,
      segments,
    };
  },
};
