import { generateScript, regenerateScene } from "@/lib/ai/script";
import type { ScriptProvider } from "../types";

export const realScriptProvider: ScriptProvider = {
  name: "anthropic",
  generateScript,
  regenerateScene({ topic, style, script, sceneIndex }) {
    return regenerateScene({ topic, style, script, sceneIndex });
  },
};
