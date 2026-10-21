/**
 * Read-only preflight for the REAL Recraft pilot. Never calls fal.ai, never prints secrets, never writes.
 * Refuses unless Hans authorized a budget explicitly (RECRAFT_PILOT_AUTHORIZED_USD) that covers the estimate.
 * Usage: RECRAFT_PILOT_AUTHORIZED_USD=0.50 SCENES=6 npx tsx scripts/recraft-pilot-preflight.ts
 */
import { recraftReelEstimateUsd } from "../src/lib/video/recraft-reel";

const scenes = Number(process.env.SCENES ?? "6");
const estimate = recraftReelEstimateUsd(scenes, Boolean(process.env.RECRAFT_STYLE_ID));
const authorized = Number(process.env.RECRAFT_PILOT_AUTHORIZED_USD ?? "0");
const checks = [
  ["FAL_KEY presente en este entorno (valor no mostrado)", Boolean(process.env.FAL_KEY?.trim())],
  ["RECRAFT_REEL_ENABLED=true", process.env.RECRAFT_REEL_ENABLED === "true"],
  [`presupuesto autorizado (USD ${authorized}) ≥ estimado Recraft (USD ${estimate})`, authorized >= estimate && authorized > 0],
] as const;
for (const [name, ok] of checks) console.log(`${ok ? "OK " : "NO "} ${name}`);
if (checks.some(([, ok]) => !ok)) { console.log("Piloto NO autorizado: no se ejecuta nada."); process.exit(1); }
console.log("Preflight OK. Siga docs/RECRAFT_FAL.md («Piloto real») desde la UI; este script no gasta.");
