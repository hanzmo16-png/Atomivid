/** Operator QA preparation from genuine approved content. Never a fresh script/customer-flow claim. */
import { createHash } from "node:crypto";
import { DocumentaryScriptSchema } from "../../src/lib/video/long-form/documentary-script";
import { isLongFormScriptJson } from "../../src/lib/video/long-form/script-json";
import { editorialApprovalError } from "../../src/lib/video/long-form/editorial";
import { countWords, evaluateNarrationDuration } from "../../src/lib/video/long-form/duration-budget";

export const SOURCE_ID = "ed438c74-b0bb-43e1-8153-ea8c993d9877";
export const ANCHOR_ID = "c6264af5-e4ec-8c36-9b9a-946bd4b09c03";
export const SOURCE_OUTPUT_SHA = "669cbe33196fd51140832837cad758a16ece99070af4187320140dad6854f48d";
const stable = (x: any): any => Array.isArray(x) ? x.map(stable) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
export const snapshotSha = (x: unknown) => createHash("sha256").update(JSON.stringify(stable(x))).digest("hex");

export function prepareTechnicalRerender(source: any, output: any, qaUserId: string, anchorUserId: string, newId: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(newId) || [SOURCE_ID, ANCHOR_ID].includes(newId)) throw Error("new identity required");
  if (!qaUserId || source.id !== SOURCE_ID || source.user_id !== qaUserId || anchorUserId !== qaUserId || source.status !== "completed" || source.render_attempts !== 3 || source.mode !== "long_form" || source.duration_seconds !== 180 || source.language !== "es" || source.style !== "Documental" || source.aspect_ratio !== "16:9" || source.video_path !== `${SOURCE_ID}/output/final.mp4`) throw Error("source scope mismatch");
  if (output.status !== "UPLOADED" || output.sha256 !== SOURCE_OUTPUT_SHA) throw Error("native source output mismatch");
  const script = source.script_json;
  if (!isLongFormScriptJson(script) || script.editorial?.status !== "approved" || editorialApprovalError(script)) throw Error("approved frozen script required");
  // Persisted scripts store only topic/beats/sources/editorial, not the writer-response title/hook envelope.
  DocumentaryScriptSchema.pick({ beats: true }).parse(script);
  const duration = evaluateNarrationDuration(script.beats.reduce((n, beat) => n + countWords(beat.narration), 0), 180);
  if (!duration.withinTolerance) throw Error("narration does not fit 180 seconds");
  const scriptSha256 = snapshotSha(script);
  // Same base fields as finish_documentary_script_job; no synthetic script-job row, plan, voice or output.
  const payload = { id: newId, user_id: qaUserId, topic: source.topic, style: "Documental", duration_seconds: 180, language: "es", mode: "long_form", aspect_ratio: "16:9", script_json: script, status: "script_ready", render_attempts: 0 };
  const provenance = { scope: "OPERATOR_TECHNICAL_RERENDER_REAL_APPROVED_SCRIPT", sourceRequestId: SOURCE_ID, sourceAttemptsPreserved: 3, sourceOutputSha256: SOURCE_OUTPUT_SHA, sourceScriptSha256: scriptSha256, newRequestId: newId, newScriptGenerated: false, customerFreshScriptFlowProved: false, paidCalls: 0, requiredNextStep: "UI configure and confirm verified total quote <= USD 2 after owner budget allocation and native QC deployment" };
  return { payload, provenance, reviewSha256: snapshotSha({ payload, provenance }), duration };
}
