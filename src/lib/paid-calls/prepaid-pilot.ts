import type { SupabaseClient } from "@supabase/supabase-js";
import type { OwnerPilot } from "@/lib/billing/owner-pilot";
/** Refresh included-credit capacity just before admission; never enable overage. */
export async function refreshPrepaidPilot(service: SupabaseClient, grant: Pick<OwnerPilot, "maxVoiceCharacters" | "maxVoiceCalls">) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("PILOT_VOICE_NOT_CONFIGURED");
  const response = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
    headers: { "xi-api-key": key }, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("PILOT_PREPAID_CAPACITY_UNAVAILABLE");
  const subscription = await response.json();
  const available = subscription.character_limit - subscription.character_count;
  if (subscription.status !== "active" || subscription.allowed_to_extend_character_limit !== false
    || subscription.can_extend_character_limit !== false || Number(subscription.current_overage?.amount ?? 0) !== 0
    || !Number.isFinite(available) || available < grant.maxVoiceCharacters * grant.maxVoiceCalls) throw new Error("PILOT_PREPAID_CAPACITY_BLOCKED");
  const { error } = await service.from("pi_capacity_snapshots").insert({ provider: "elevenlabs", unit: "character", available,
    reserved: 0, pending: 0, health: "OK", reliability: "provider_api", status: "GREEN", checked_at: new Date().toISOString() });
  if (error) throw new Error("PILOT_CAPACITY_RECORD_FAILED");
}
