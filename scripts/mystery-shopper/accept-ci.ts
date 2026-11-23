/**
 * Comprueba un evento de GitHub o Vercel antes de correr el modo gratuito.
 * Rechaza cualquier modo real o facturable.
 */
import { acceptCiEvent } from "../../src/lib/mystery-shopper/ci-trigger";

const source = process.env.MS_EVENT_SOURCE === "vercel" ? "vercel" : "github";
const decision = acceptCiEvent({
  source,
  executionId: process.env.MS_EXECUTION_ID || `github:${process.env.GITHUB_RUN_ID || "local"}:audio-flannan`,
  sha: process.env.MS_EVENT_SHA || process.env.GITHUB_SHA || "",
  conclusion: process.env.MS_EVENT_CONCLUSION || "success",
  preview: process.env.MS_EVENT_PREVIEW,
  missionId: process.env.MS_MISSION || "audio-flannan",
  mode: process.env.MS_EVENT_MODE || "fixture",
  billable: process.env.MS_EVENT_BILLABLE === "true",
}, new Set(process.env.MS_ALREADY?.split(",").filter(Boolean) ?? []));
console.log(JSON.stringify(decision));
if (!decision.accept) process.exit(1);
