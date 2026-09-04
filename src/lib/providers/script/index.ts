import type { ScriptProvider } from "../types";
import { realScriptProvider } from "./real";
import { fixtureScriptProvider } from "./fixture";

export function getScriptProvider(): ScriptProvider {
  if (process.env.SCRIPT_PROVIDER === "fixture") return fixtureScriptProvider;
  if (process.env.SCRIPT_PROVIDER === "anthropic") return realScriptProvider;
  return process.env.ANTHROPIC_API_KEY ? realScriptProvider : fixtureScriptProvider;
}

export type { ScriptProvider, GeneratedScript, ScriptScene } from "../types";
