import { requireRealProvider } from "../production";
import type { FootageProvider } from "../types";
import { realFootageProvider } from "./real";
import { fixtureFootageProvider } from "./fixture";

export function getFootageProvider(): FootageProvider {
  const requested = process.env.FOOTAGE_PROVIDER?.trim();
  requireRealProvider("footage", (!requested || requested === "pexels") && Boolean(process.env.PEXELS_API_KEY?.trim()));
  if (process.env.FOOTAGE_PROVIDER === "fixture") return fixtureFootageProvider;
  if (process.env.FOOTAGE_PROVIDER === "pexels") return realFootageProvider;
  return process.env.PEXELS_API_KEY ? realFootageProvider : fixtureFootageProvider;
}

export type { FootageProvider, FootageResult } from "../types";
