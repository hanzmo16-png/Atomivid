/**
 * Visual release preflight of a v4+ plan (identity, HERO coverage, text-card ratio, opening card run).
 * ONE implementation shared by the worker (produce.ts, which stops before any paid call) and the
 * Configure page (which shows the same verdict BEFORE the user starts). Light module: no renderer,
 * no providers. Reads only the request's curation file; never writes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { planReleaseBlockers } from "./cinematic-director";
import { heroCoverage, VerifiedAssetRegistry, type HeroCoverage } from "./verified-assets";
import { CURATION_FILE_PATH, isAuthorizedCurator, requestedContracts } from "./asset-curation";
import { containsFixtureOnlyMaterial } from "./fixture-only";
import { PLAN_ESTIMATE_AVAILABILITY, registryAvailability, resolveSequences, usesSequences, validateImpactIntents, validateSequenceIntents, type ExecutableSequence } from "./sequence-intent";
import { planSequenceShots } from "./sequence-direction";
import { planShotsFromScript, type ProductionPlan, type ProductionPlanBeatInput } from "./production-plan";
import { usesImpactDirection } from "./production-plan-types";
import { LongFormVisualQualityError } from "./visual-report";

/** Same constant the renderer enforces at runtime (max share of scenes that may end as text cards). */
export const MAX_TEXT_FALLBACK_RATIO = 0.25;
const BUCKET = "videos";

export type VisualReleasePreflight = {
  blockers: string[];
  coverage: HeroCoverage | null;
  verifiedAssets: VerifiedAssetRegistry;
  sequences?: ExecutableSequence[];
  plannedShotCount: number;
};

/**
 * Verified registry of this request: the curation file is untrusted data; trust is recomputed here
 * (license, quality, credit, fingerprint, curator authorized TODAY, state, exact requested contract).
 * Absent or unreadable = empty. Fixture/test material never enters a real request.
 */
export async function loadVerifiedAssets(supabase: SupabaseClient, requestId: string, contracts: ReadonlySet<string>): Promise<VerifiedAssetRegistry> {
  let raw: unknown;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(CURATION_FILE_PATH(requestId));
    if (error || !data) return VerifiedAssetRegistry.empty();
    raw = JSON.parse(await data.text());
  } catch {
    return VerifiedAssetRegistry.empty();
  }
  if (containsFixtureOnlyMaterial(raw)) throw new LongFormVisualQualityError(["FIXTURE_ONLY_MATERIAL: el archivo de curaduría contiene material de prueba; una solicitud real nunca lo usa"]);
  return VerifiedAssetRegistry.rehydrate(raw, { requestId, isAuthorizedCurator: (by) => isAuthorizedCurator(by), requestedContracts: contracts });
}

export async function visualReleasePreflight(input: {
  supabase: SupabaseClient;
  requestId: string;
  plan: ProductionPlan;
  beats: ProductionPlanBeatInput[];
  topic: string;
  /** Injected registry (tests/simulation); otherwise loaded from the request's curation file. */
  verifiedAssets?: VerifiedAssetRegistry;
}): Promise<VisualReleasePreflight> {
  const { plan, beats } = input;
  const v5 = usesSequences(plan);
  if (v5) {
    const check = validateSequenceIntents(plan.sequences, beats);
    if (usesImpactDirection(plan)) check.errors.push(...validateImpactIntents(plan.sequences!));
    if (check.errors.length > 0) {
      return { blockers: check.errors.map((e) => `SEQUENCE_CONTRACT: ${e}`), coverage: null, verifiedAssets: VerifiedAssetRegistry.empty(), plannedShotCount: 0 };
    }
  }
  const estimate = v5
    ? planSequenceShots(beats, resolveSequences(plan.sequences!, PLAN_ESTIMATE_AVAILABILITY)).shots
    : planShotsFromScript(beats, input.topic, plan.strategy).shots;
  const verifiedAssets = input.verifiedAssets ?? (await loadVerifiedAssets(input.supabase, input.requestId, new Set(requestedContracts(estimate).keys())));
  const sequences = v5 ? resolveSequences(plan.sequences!, registryAvailability(verifiedAssets)) : undefined;
  const plannedShots = sequences ? planSequenceShots(beats, sequences).shots : estimate;
  const blockers = planReleaseBlockers(plannedShots).map((f) => `${f.code}: ${f.detail} (${f.shots.join(", ")})`);
  const coverage = heroCoverage(plannedShots, verifiedAssets, MAX_TEXT_FALLBACK_RATIO);
  const missing = [...coverage.heroMissingRequiredIdentities, ...coverage.heroMissingRequiredEvidence, ...coverage.missingIdentities, ...coverage.missingEvidence];
  blockers.push(...coverage.blockers.map((b) => `HERO_COVERAGE ${b} (faltan: ${[...new Set(missing)].join(", ") || "—"})`));
  return { blockers, coverage, verifiedAssets, sequences, plannedShotCount: plannedShots.length };
}
