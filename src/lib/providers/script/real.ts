import { generateScript, regenerateScene } from "@/lib/ai/script";
import type { ScriptProvider } from "../types";

// Every actual call/correction reserves supply. Network uncertainty never triggers
// an automatic new charge; the caller retains its request for deliberate recovery.
export const realScriptProvider: ScriptProvider = {
  name: "anthropic",
  generateScript,
  regenerateScene,
};
