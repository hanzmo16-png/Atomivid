#!/usr/bin/env node
import fs from "node:fs";
import { pilotBudgetEnvelope, type PilotStageEstimate } from "../src/lib/video/long-form/pilot-budget-envelope";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Uso: node --import tsx scripts/long-form-pilot-budget.ts <estimaciones.json>");
  process.exitCode = 2;
} else {
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as {
    stages: PilotStageEstimate[];
    contingencyPct?: number;
  };
  const result = pilotBudgetEnvelope(input.stages, input.contingencyPct ?? 20);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}
