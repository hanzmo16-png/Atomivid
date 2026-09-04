import { generateScript } from "@/lib/ai/script";
import type { ScriptProvider } from "../types";

export const realScriptProvider: ScriptProvider = {
  name: "anthropic",
  generateScript: generateScript,
};
