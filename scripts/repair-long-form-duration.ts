/** One-shot ops branch only. No production/retry/provider/accounting code is invoked. */
import fs from "node:fs/promises";
import path from "node:path";
import { createServiceClient } from "../src/lib/supabase/service";
import { supabaseOutputDeps, canonicalOutputPath, type LongFormOutputState } from "../src/lib/video/long-form/output-finalize";
import { assertProof, ORIGINAL_BYTES, ORIGINAL_SHA256, NATIVE_RUN_ID, REPAIR_REQUEST_ID, ROOT_DRIVE_RECEIPT_SHA256, createDurationRepair, applyDurationRepair, hash, stableJson, type PreservationProof } from "../src/lib/video/long-form/free-duration-repair";

async function main() {
  const env = process.env;
  const mode = env.MODE ?? "validate";
  if (!["record-original-proof", "validate", "apply"].includes(mode)) throw new Error("explicit_mode_required");
  for (const [key, value] of Object.entries(env)) if (value && /^(ELEVENLABS|ANTHROPIC|OPENAI|PEXELS|FAL|RECRAFT|VEO|BEATOVEN).*KEY$/.test(key)) throw new Error("provider_credential_forbidden");
  if (env.GITHUB_REPOSITORY !== "hanzmo16-png/Atomivid" || !env.GITHUB_TOKEN) throw new Error("repository_context_required");
  if (env.GITHUB_ACTOR !== env.GITHUB_REPOSITORY_OWNER) throw new Error("repository_owner_required");
  const runRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${NATIVE_RUN_ID}`, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
  if (!runRes.ok) throw new Error("native_run_read_failed");
  const native = await runRes.json() as { status: string; conclusion: string };
  if (native.status !== "completed" || native.conclusion !== "success") throw new Error("native_run_not_closed_success");
  const service = createServiceClient(), storage = service.storage.from("videos"), requestId = REPAIR_REQUEST_ID;
  const bucket = await service.storage.getBucket("videos");
  if (bucket.error || bucket.data?.public !== false) throw new Error("private_evidence_bucket_required");
  const objectPath = canonicalOutputPath(requestId);
  const prefix = `${requestId}/state/free-duration-repair-v1`;
  const rootProofPath = `${prefix}/root-preservation-proof.json`;
  async function download(p: string) { const { data, error } = await storage.download(p); if (error || !data) throw new Error("required_object_read_failed"); return Buffer.from(await data.arrayBuffer()); }
  async function immutable(p: string, bytes: Buffer, type = "application/json") { const { error } = await storage.upload(p, bytes, { upsert: false, contentType: type }); if (error) throw new Error("immutable_write_failed_or_intent_exists_NO_RETRY"); }
  if (mode === "record-original-proof") {
    if (env.ROOT_DRIVE_RECEIPT_SHA256 !== ROOT_DRIVE_RECEIPT_SHA256) throw new Error("exact_root_receipt_hash_required");
    const { data: row, error } = await service.from("video_requests").select("user_id,status,render_attempts,mode").eq("id", requestId).single();
    if (error || row?.status !== "completed" || row.render_attempts !== 1 || row.mode !== "long_form") throw new Error("closed_qa_request_required");
    const source = await download(objectPath);
    if (source.length !== ORIGINAL_BYTES || hash(source) !== ORIGINAL_SHA256) throw new Error("original_changed_before_root_record");
    const recorded: PreservationProof = {
      version: 1, requestId, qaOwnerId: row.user_id, rootOwnerLogin: env.GITHUB_REPOSITORY_OWNER!,
      originalSha256: ORIGINAL_SHA256, originalBytes: ORIGINAL_BYTES, nativeRunId: NATIVE_RUN_ID,
      drive: { rootReceiptSha256: ROOT_DRIVE_RECEIPT_SHA256, independentReadback: true, method: "GoogleDriveConnector", privateOwnerOnly: true, verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      ledgerObjectPaths: [`${requestId}/state/request-budget.json`, `${requestId}/state/production-budget.json`],
    };
    assertProof(recorded, env.GITHUB_REPOSITORY_OWNER!, env.GITHUB_ACTOR!);
    const bytes = Buffer.from(stableJson(recorded));
    await immutable(rootProofPath, bytes);
    console.log(JSON.stringify({ rootProofSha256: hash(bytes), path: rootProofPath, originalUnmodified: true }));
    return;
  }
  if (env.PRIVATE_PROOF_PATH !== rootProofPath) throw new Error("exact_private_proof_path_required");
  const rawProof = await download(rootProofPath);
  const proofHash = hash(rawProof);
  if (proofHash !== env.PRESERVATION_PROOF_SHA256) throw new Error("root_proof_hash_mismatch");
  const proof = JSON.parse(rawProof.toString()) as PreservationProof;
  assertProof(proof, env.GITHUB_REPOSITORY_OWNER ?? "", env.GITHUB_ACTOR ?? "");
  const dir = env.REPAIR_ARTIFACT_DIR ?? path.join(process.cwd(), "repair-private-artifacts");
  await fs.mkdir(dir, { recursive: true });
  const original = path.join(dir, "original.mp4"), candidate = path.join(dir, "candidate.mp4");
  const originalBytes = await download(objectPath);
  if (hash(originalBytes) !== ORIGINAL_SHA256 || originalBytes.length !== ORIGINAL_BYTES) throw new Error("exact_original_required");
  await fs.writeFile(original, originalBytes);
  const finalDeps = supabaseOutputDeps(service);
  const state = await finalDeps.readState(requestId);
  if (!state) throw new Error("original_state_required");
  const budgetBytes = await download(`${requestId}/state/request-budget.json`);
  const budget = JSON.parse(budgetBytes.toString()) as { ledgerScopes: string[] };
  if (!Array.isArray(budget.ledgerScopes) || !budget.ledgerScopes.includes(requestId)) throw new Error("ledger_scopes_required");
  async function snapshot() {
    const [r, g, pi] = await Promise.all([
      service.from("video_requests").select("*").eq("id", requestId).single(),
      service.from("generation_costs").select("*").eq("request_id", requestId).order("request_id"),
      service.from("pi_paid_operations").select("*").in("project_id", budget.ledgerScopes).order("idempotency_key"),
    ]);
    if (r.error || g.error || pi.error || !r.data || !g.data?.length || !pi.data?.length) throw new Error("financial_snapshot_incomplete");
    if (r.data.user_id !== proof.qaOwnerId || r.data.status !== "completed" || r.data.mode !== "long_form" || r.data.render_attempts !== 1 || r.data.video_path !== objectPath || r.data.duration_seconds !== 180) throw new Error("exact_closed_qa_request_required");
    if (pi.data.some(x => ["RESERVED", "SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"].includes(x.status))) throw new Error("pending_operations_forbidden");
    const ledgers = [];
    for (const p of proof.ledgerObjectPaths) ledgers.push({ path: p, sha256: hash(await download(p)) });
    return { request: r.data, generationCosts: g.data, piOperations: pi.data, ledgerHashes: ledgers, requestBudgetSha256: hash(await download(`${requestId}/state/request-budget.json`)) };
  }
  const before = await snapshot();
  await fs.writeFile(path.join(dir, "before-private.json"), stableJson({ state, snapshot: before, proofHash }));
  const media = await createDurationRepair(original, candidate, 180);
  await fs.writeFile(path.join(dir, "candidate-qc.json"), JSON.stringify(media, null, 2));
  if (mode === "validate") { console.log(JSON.stringify({ mode, originalSha256: ORIGINAL_SHA256, candidateSha256: media.candidateHash, duration: media.after.duration, snapshotSha256: hash(stableJson(before)) })); return; }
  const result = await applyDurationRepair({ requestId, original, candidate, proofHash, state, candidateHash: media.candidateHash }, {
    finalize: {
      ...finalDeps,
      upload: async (p, file) => {
        const { error } = await storage.upload(p, await fs.readFile(file), { contentType: "video/mp4", upsert: true });
        if (error) throw new Error("canonical_upload_ambiguous_NO_RETRY");
        return { method: "standard", attempts: [{ method: "standard", attempt: 1, ok: true }] };
      },
    },
    canonicalHash: async () => hash(await download(objectPath)), snapshot,
    createIntent: async intent => immutable(`${prefix}/intent.json`, Buffer.from(stableJson(intent))),
    preserve: async (source, output, originalState: LongFormOutputState) => {
      await immutable(`${prefix}/original-state.json`, Buffer.from(stableJson(originalState)));
      await immutable(`${prefix}/original-${ORIGINAL_SHA256}.mp4`, await fs.readFile(source), "video/mp4");
      await immutable(`${prefix}/candidate-${media.candidateHash}.mp4`, await fs.readFile(output), "video/mp4");
    },
  });
  const after = await snapshot();
  const afterState = await finalDeps.readState(requestId);
  if (afterState?.costsRecorded !== true || afterState.sha256 !== media.candidateHash || afterState.attempt !== 1) throw new Error("repair_state_readback_failed_NO_RETRY");
  const receipt = { lineage: result.lineage, beforeSha256: result.beforeHash, afterSha256: hash(stableJson(after)), afterSnapshot: after, afterState, media };
  await immutable(`${prefix}/result.json`, Buffer.from(stableJson(receipt)));
  await fs.writeFile(path.join(dir, "after-private.json"), stableJson({ receipt, snapshot: after }));
  console.log(JSON.stringify({ result: "repaired_without_providers_or_accounting", candidateSha256: media.candidateHash, attempt: 1, costsRecorded: true }));
}
main().catch(err => { console.error(err instanceof Error ? err.message : "repair_failed_NO_RETRY"); process.exitCode = 1; });
