/** Read-only provider checks, then a bounded grant from private operator material. No generation. */
import { z } from "zod";
import { createServiceClient } from "../src/lib/supabase/service";
import { supabaseLedgerStore } from "../src/lib/paid-calls/supabase-ledger-store";
import { stableHash } from "../src/lib/production-intelligence/canonical";
import { getVoiceIdentity } from "../src/lib/ai/voice";
import { OwnerPilotSchema, ownerPilotKey } from "../src/lib/billing/owner-pilot";
import { MUSIC_MANIFEST } from "../src/lib/providers/music/manifest";
import { checkScriptContentQuality } from "../src/lib/video/script-quality";
import { targetWordsFor } from "../src/lib/video/script-pacing";
import { loadReelLogo } from "../src/lib/video/reel-logo";
const preparationKey = process.env.OWNER_PILOT_PREPARATION_KEY?.trim() || "owner_pilot_preparation_current";
const Input = z.object({ ownerId: z.string().uuid(), requestId: z.string().uuid(),
  script: z.object({ title: z.string().min(1), segments: z.array(z.object({ text: z.string().min(1), visualQuery: z.string().min(1),
    visualConcepts: z.array(z.string()).optional(), energy: z.enum(["low","medium","high"]).optional() }).strict()).min(1).max(10) }).strict() }).strict();
async function main() {
  const service = createServiceClient(), ledger = supabaseLedgerStore(service);
  const record = await ledger.get(preparationKey);
  if (record?.status !== "COMMITTED" || record.method !== "human_direction" || record.provider !== "internal"
    || record.reservedUsd !== 0 || record.committedUsd !== 0 || !record.resultRef) throw new Error("PILOT_MATERIAL_NOT_AUTHORIZED");
  const input = Input.parse(JSON.parse(record.resultRef));
  if (record.projectId !== input.requestId) throw new Error("PILOT_MATERIAL_NOT_AUTHORIZED");
  const { data: auth, error: authError } = await service.auth.admin.getUserById(input.ownerId);
  const request = await service.from("video_requests").select("user_id,mode,topic,duration_seconds,status,render_attempts,language,brand_logo_path").eq("id", input.requestId).single();
  if (authError || !auth.user?.email_confirmed_at || request.error || request.data.user_id !== input.ownerId
    || request.data.mode !== "visual" || request.data.language !== "es" || request.data.duration_seconds !== 30
    || request.data.render_attempts !== 0 || !["pending","script_ready"].includes(request.data.status)) throw new Error("PILOT_SCOPE_BLOCKED");
  // Validate this request's private logo before granting its render.
  await loadReelLogo(service, input.ownerId, input.requestId, request.data.brand_logo_path);
  const quality = checkScriptContentQuality(input.script, { topic: request.data.topic, targetWords: targetWordsFor(30) });
  if (!quality.ok) throw new Error("PILOT_SCRIPT_QUALITY_BLOCKED");
  const identity = getVoiceIdentity("es");
  if (identity.modelId !== "eleven_multilingual_v2") throw new Error("PILOT_MODEL_CHANGED");
  const characters = input.script.segments.map(s => s.text).join(" ").length;
  if (characters > 1000) throw new Error("PILOT_TEXT_TOO_LONG");
  const key = process.env.ELEVENLABS_API_KEY, pexelsKey = process.env.PEXELS_API_KEY;
  if (!key || !pexelsKey) throw new Error("PILOT_CONNECTION_NOT_CONFIGURED");
  async function get(path: string) {
    const response = await fetch("https://api.elevenlabs.io/v1/" + path, { headers: { "xi-api-key": key! }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("PILOT_VOICE_CONNECTION_FAILED");
    return response.json();
  }
  const [subscription, voice, models] = await Promise.all([get("user/subscription"), get("voices/" + encodeURIComponent(identity.voiceId)), get("models")]);
  const model = models.find((item: { model_id: string }) => item.model_id === identity.modelId);
  const available = subscription.character_limit - subscription.character_count;
  // Only included credits, no overage or automatic credit extension, known 1:1 cost.
  if (subscription.status !== "active" || subscription.allowed_to_extend_character_limit !== false
    || subscription.can_extend_character_limit !== false || Number(subscription.current_overage?.amount ?? 0) !== 0
    || !Number.isFinite(available) || available < characters * 2
    || !model?.can_do_text_to_speech || model.token_cost_factor !== 1
    || (voice.sharing?.rate ?? 1) !== 1 || voice.sharing?.fiat_rate != null) throw new Error("PILOT_PREPAID_BUDGET_UNVERIFIED");
  const footageQuery = encodeURIComponent(input.script.segments[0].visualQuery);
  const footage = await fetch(`https://api.pexels.com/videos/search?query=${footageQuery}&per_page=1`, { headers: { Authorization: pexelsKey }, signal: AbortSignal.timeout(30000) });
  if (!footage.ok || !(await footage.json()).videos?.length) throw new Error("PILOT_FOOTAGE_CONNECTION_FAILED");
  const tracks = await service.storage.from("music-library").list("", { limit: 100 });
  if (tracks.error || !MUSIC_MANIFEST.some(track => track.instrumental && tracks.data.some(file => file.name === track.storagePath))) throw new Error("PILOT_MUSIC_CONNECTION_FAILED");
  const checkedAt = new Date().toISOString();
  const account = await service.from("pi_provider_accounts").select("provider").eq("provider", "elevenlabs").maybeSingle();
  if (account.error) throw new Error("PILOT_ACCOUNT_REGISTRY_UNAVAILABLE");
  if (!account.data) {
    const registered = await service.from("pi_provider_accounts").insert({ provider: "elevenlabs", production_account_label: "Configured official ElevenLabs API account",
      plan: subscription.tier, secret_reference_name: "ELEVENLABS_API_KEY", status: "active", balance_source: "provider_api" });
    if (registered.error && registered.error.code !== "23505") throw new Error("PILOT_ACCOUNT_REGISTRATION_FAILED");
  }
  const grant = OwnerPilotSchema.parse({ version: "owner-pilot/1", ownerId: input.ownerId, requestId: input.requestId,
    expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(), scriptSha256: stableHash(input.script, 64),
    maxDurationSeconds: 30, maxRenderAttempts: 1, budgetVerified: true, maxVoiceCalls: 2,
    maxVoiceCharacters: characters, billingBasis: "prepaid_no_overage", voiceUsdPer1kChars: 0,
    maxProviderUsd: 0, voiceId: identity.voiceId, modelId: identity.modelId,
    quoteEvidence: `Official account API at ${checkedAt}: ${available} included credits available; at most ${characters * 2} credits; overage and credit extension disabled. No additional cash charge. Public repository runner and existing licensed music.` });
  const snapshot = await service.from("pi_capacity_snapshots").insert({ provider: "elevenlabs", unit: "character", available,
    reserved: 0, pending: 0, health: "OK", reliability: "provider_api", status: "GREEN", checked_at: checkedAt });
  if (snapshot.error) throw new Error("PILOT_CAPACITY_RECORD_FAILED");
  const prior = await ledger.get(ownerPilotKey(input.requestId));
  if (prior && (prior.status !== "COMMITTED" || JSON.parse(prior.resultRef!).scriptSha256 !== grant.scriptSha256)) throw new Error("PILOT_GRANT_CONFLICT");
  if (!prior) await ledger.insert({ idempotencyKey: ownerPilotKey(input.requestId), projectId: input.requestId, shotId: "owner-pilot-grant",
    provider: "internal", model: grant.version, method: "human_direction", attemptKind: "pilot", reservedUsd: 0, committedUsd: 0,
    status: "COMMITTED", providerJobId: null, resultRef: JSON.stringify(grant), updatedAt: checkedAt });
  const saved = await service.from("video_requests").update({ script_json: input.script, status: "script_ready", error_message: null })
    .eq("id", input.requestId).eq("user_id", input.ownerId).eq("render_attempts", 0).in("status", ["pending","script_ready"]).select("id");
  if (saved.error || saved.data?.length !== 1) throw new Error("PILOT_PREPARATION_CONFLICT");
  await ledger.insert({ idempotencyKey: "owner_pilot_preflight_" + process.env.GITHUB_RUN_ID, projectId: input.requestId, shotId: "connection-preflight",
    provider: "internal", model: "owner-pilot-preflight/1", method: "read_only_preflight", attemptKind: "pilot", reservedUsd: 0, committedUsd: 0,
    status: "COMMITTED", providerJobId: null, resultRef: JSON.stringify({ checkedAt, grant, subscription, voice, model, paidCalls: 0 }), updatedAt: checkedAt });
  console.log("PILOT_PREPARED_CONNECTIONS_VERIFIED_NO_GENERATION");
}
main().catch(async error => {
  try {
    const ledger = supabaseLedgerStore(createServiceClient());
    const prepared = await ledger.get(preparationKey);
    if (prepared) await ledger.insert({ idempotencyKey: "owner_pilot_preflight_failure_" + process.env.GITHUB_RUN_ID,
      projectId: prepared.projectId, shotId: "connection-preflight", provider: "internal", model: "owner-pilot-preflight/1",
      method: "private_diagnostic", attemptKind: "pilot", reservedUsd: 0, committedUsd: 0, status: "COMMITTED",
      providerJobId: null, resultRef: JSON.stringify({ error: error instanceof Error ? error.message : "unknown", paidCalls: 0 }), updatedAt: new Date().toISOString() });
  } catch { /* Logging cannot authorize production. */ }
  console.error("PILOT_PREFLIGHT_BLOCKED_NO_GENERATION"); process.exitCode = 1;
});
