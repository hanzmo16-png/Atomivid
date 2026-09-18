import { requireRealProvider } from "../production";
import type { ScriptProvider } from "../types";
import { realScriptProvider } from "./real";
import { fixtureScriptProvider } from "./fixture";

export function getScriptProvider(): ScriptProvider {
  const requested = process.env.SCRIPT_PROVIDER?.trim();
  requireRealProvider("script", (!requested || requested === "anthropic") && Boolean(process.env.ANTHROPIC_API_KEY?.trim()));
  if (process.env.SCRIPT_PROVIDER === "fixture") return fixtureScriptProvider;
  if (process.env.SCRIPT_PROVIDER === "anthropic") return realScriptProvider;
  return process.env.ANTHROPIC_API_KEY ? realScriptProvider : fixtureScriptProvider;
}

export type { ScriptProvider, GeneratedScript, ScriptScene } from "../types";
