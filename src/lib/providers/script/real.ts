import { generateScript, regenerateScene } from "@/lib/ai/script";
import type { ScriptProvider } from "../types";

// Sin reintentos genéricos aquí: la política vive en callScriptModel
// (src/lib/ai/script.ts), por llamada real, y solo repite lo que no pudo
// cobrarse (solicitud no enviada o 429). Antes, un withRetry repetía
// CUALQUIER error hasta 3 veces — incluida una respuesta ya recibida (y
// cobrada) sin guion utilizable. Tampoco se sustituye el contenido por el
// fixture si falla: un guion templado no debe llegarle a un usuario real
// sin que lo sepa. El error se propaga y la solicitud queda en "failed"
// para reintentar manualmente; el fixture solo se usa cuando falta
// ANTHROPIC_API_KEY (src/lib/providers/script/index.ts).
export const realScriptProvider: ScriptProvider = {
  name: "anthropic",
  generateScript(input) {
    return generateScript(input);
  },
  regenerateScene(input) {
    return regenerateScene(input);
  },
};
