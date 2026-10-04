import type { SupabaseClient } from "@supabase/supabase-js";
import type { OwnerFormTrial } from "@/lib/billing/owner-form-trial";
import { generateScript, type ScriptCallResult } from "@/lib/ai/script";
import { guardPaidCall } from "@/lib/paid-calls/gate";
import { ownerFormTrialLedger } from "@/lib/paid-calls/owner-form-trial-ledger";
import { supabaseResultStore, paidResultPath } from "@/lib/paid-calls/result-store";

/** Uses the production prompts/schema. Every length correction has its own reservation. */
export async function generateOwnerFormScript(service: SupabaseClient, grant: OwnerFormTrial) {
  const ledger = ownerFormTrialLedger(service, grant), results = supabaseResultStore(service);
  const script = await generateScript({ topic: grant.topic, style: grant.style, language: grant.language,
    durationSeconds: grant.durationSeconds, execution: { model: grant.scriptModel, async call(attempt, input, invoke) {
      // Byte upper bound + 8192 tokens of structured-output overhead + 6000 output tokens,
      // at $2/$10 per million, stays below the $0.15 hold. No caches/tools/batches.
      if (attempt > grant.maxScriptCalls || Buffer.byteLength(JSON.stringify(input)) > 24_000)
        throw new Error("OWNER_FORM_TRIAL_SCRIPT_INPUT_TOO_LARGE");
      const paid = await guardPaidCall<ScriptCallResult>(ledger, {
        projectId: grant.requestId, shotId: `script:main-${attempt}`, provider: "anthropic", model: grant.scriptModel,
        method: "generate_script", inputFingerprint: input, reservedUsd: grant.scriptReservationUsd,
      }, { async call({ key }) {
        const output = await invoke();
        if (!Number.isSafeInteger(output.inputTokens) || output.inputTokens < 0
          || !Number.isSafeInteger(output.outputTokens) || output.outputTokens < 0)
          throw new Error("OWNER_FORM_TRIAL_SCRIPT_USAGE_UNKNOWN");
        const costUsd = (output.inputTokens * 2 + output.outputTokens * 10) / 1_000_000;
        if (costUsd > grant.scriptReservationUsd) throw new Error("OWNER_FORM_TRIAL_SCRIPT_RESERVATION_EXCEEDED");
        const resultRef = paidResultPath(grant.requestId, key, "script.json");
        await results.putJson(resultRef, output);
        return { result: output, costUsd, resultRef };
      }, load: ref => results.getJson<ScriptCallResult>(ref) });
      return paid.result;
    } } });
  return { script, providerName: "anthropic" };
}
