/**
 * T46 D3 read-only evidence collector for one exact create_avatar operation.
 *
 * Required environment:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   AVATAR_RECONCILE_PROJECT_REF       (must match the URL host)
 *   AVATAR_RECONCILE_OPERATION_KEY     (full op_... key; never printed)
 *   AVATAR_RECONCILE_OWNER_ID          (UUID; never printed)
 *
 * Run: npx tsx scripts/avatar-reconciliation-readonly.ts
 *
 * The source deliberately contains no mutation or provider operation. It emits
 * only hashes, booleans, counts and the pure D3 decision.
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { classifyAvatarCreationEvidence } from "../src/lib/video/avatar/reconciliation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OP_KEY = /^op_[0-9a-f]{32}$/i;
const PROVIDER_KEYS = ["HEYGEN_API_KEY", "D_ID_API_KEY", "DID_API_KEY"];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main() {
  if (PROVIDER_KEYS.some(name => process.env[name]?.trim()))
    throw new Error("provider credentials must not be present in this read-only process");

  const url = required("SUPABASE_URL");
  const key = required("SUPABASE_SERVICE_ROLE_KEY");
  const expectedProject = required("AVATAR_RECONCILE_PROJECT_REF");
  const operationKey = required("AVATAR_RECONCILE_OPERATION_KEY");
  const ownerId = required("AVATAR_RECONCILE_OWNER_ID");
  const host = new URL(url).hostname;
  if (host !== `${expectedProject}.supabase.co`) throw new Error("Supabase project mismatch");
  if (!OP_KEY.test(operationKey)) throw new Error("invalid operation key");
  if (!UUID.test(ownerId)) throw new Error("invalid owner id");

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const opRead = await db.from("pi_paid_operations")
    .select("idempotency_key,project_id,provider,method,status,provider_job_id,result_ref,updated_at")
    .eq("idempotency_key", operationKey)
    .eq("method", "create_avatar")
    .maybeSingle();
  if (opRead.error || !opRead.data) throw new Error("operation read failed");

  const projectId = String(opRead.data.project_id);
  if (!UUID.test(projectId)) throw new Error("operation project id is not a request UUID");

  const [avatarRead, requestRead, claimRead] = await Promise.all([
    db.from("avatars")
      .select("status,provider,provider_avatar_id,provider_job_id,source_photo_path")
      .eq("user_id", ownerId)
      .like("source_photo_path", `${ownerId}/${projectId}%`)
      .limit(10),
    db.from("video_requests")
      .select("status,avatar_id")
      .eq("id", projectId)
      .eq("user_id", ownerId)
      .maybeSingle(),
    db.storage.from("avatar-uploads").list(ownerId, { search: projectId, limit: 100 }),
  ]);

  const readsComplete = !avatarRead.error && !requestRead.error && !claimRead.error;
  const avatars = (avatarRead.data ?? []) as Array<Record<string, unknown>>;
  const claimPresent = (claimRead.data ?? []).some(item => {
    const name = String(item.name ?? "");
    return name === projectId || name.startsWith(`${projectId}.`);
  });
  const providerAvatarPresent = avatars.length === 1 &&
    typeof avatars[0].provider_avatar_id === "string" &&
    avatars[0].provider_avatar_id.trim().length > 0;

  const evidence = {
    readsComplete,
    method: String(opRead.data.method),
    status: String(opRead.data.status),
    providerJobPresent: typeof opRead.data.provider_job_id === "string" && opRead.data.provider_job_id.length > 0,
    resultRefPresent: typeof opRead.data.result_ref === "string" && opRead.data.result_ref.length > 0,
    claimPresent,
    matchingAvatarRows: avatars.length,
    providerAvatarPresent,
    requestPresent: !!requestRead.data,
  };
  const decision = classifyAvatarCreationEvidence(evidence);

  console.log(JSON.stringify({
    kind: "ATOMIVID_AVATAR_RECONCILIATION_READ_ONLY",
    observedAt: new Date().toISOString(),
    scope: {
      operationHash: hash(operationKey),
      requestHash: hash(projectId),
      ownerHash: hash(ownerId),
      provider: String(opRead.data.provider),
    },
    evidence,
    decision,
    invariants: {
      providerCalled: false,
      dataWritten: false,
      mayResubmit: false,
      settlementPerformed: false,
    },
  }, null, 2));
}

main().catch(error => {
  console.error("AVATAR_RECONCILIATION_READ_FAILED", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
