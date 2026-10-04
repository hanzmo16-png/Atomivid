/** Recover existing encrypted review bytes. No rendering or provider credentials. */
import { createDecipheriv, createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServiceClient } from "../../src/lib/supabase/service";
import { supabaseLedgerStore } from "../../src/lib/paid-calls/supabase-ledger-store";
import { supabaseResultStore } from "../../src/lib/paid-calls/result-store";
import { supabaseJobStore } from "../../src/lib/production-intelligence/vfx-director/store";
import { ownedJob, jobGates } from "../../src/lib/production-intelligence/vfx-director/jobs";
import { directorActor } from "../../src/lib/production-intelligence/vfx-director/access";
import { currentReviewBinding, type ReviewBinding } from "../../src/lib/production-intelligence/vfx-director/review-bindings";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function main() {
  const service = createServiceClient(), ledger = supabaseLedgerStore(service), results = supabaseResultStore(service);
  const receipt = JSON.parse(await readFile("review-capsule/delivery.json", "utf8"));
  if (!/^vfx_native_opening_review_\d+_\d+$/.test(receipt.deliveryKey)) throw new Error("DELIVERY_INVALID");
  const delivery = await ledger.get(receipt.deliveryKey);
  const approval = await ledger.get("vfx_native_integration_owner_review_20261003_214023");
  if (delivery?.status !== "COMMITTED" || delivery.method !== "encrypted_delivery" || !delivery.resultRef
    || approval?.status !== "COMMITTED" || approval.method !== "human_review" || !approval.resultRef) throw new Error("REVIEW_NOT_REGISTERED");
  const cfg = JSON.parse(delivery.resultRef), review = JSON.parse(approval.resultRef);
  if (!review.approved || review.maximumAdditionalUsd !== 0 || cfg.ownerId !== review.ownerId || delivery.projectId !== review.projectId) throw new Error("REVIEW_SCOPE_INVALID");
  const user = await service.auth.admin.getUserById(review.ownerId);
  if (user.error || directorActor(user.data.user) !== review.ownerId) throw new Error("OWNER_INVALID");
  const job = await ownedJob(supabaseJobStore(service), review.projectId, review.ownerId);
  const encrypted = await readFile("review-capsule/opening-review.enc");
  if (hash(encrypted) !== cfg.encryptedSha256 || encrypted.length < 28) throw new Error("CAPSULE_CHANGED");
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(cfg.keyBase64, "base64"), encrypted.subarray(0, 12));
  cipher.setAuthTag(encrypted.subarray(-16));
  const plain = Buffer.concat([cipher.update(encrypted.subarray(12, -16)), cipher.final()]);
  if (hash(plain) !== cfg.plainSha256) throw new Error("CAPSULE_CHANGED");
  const root = await mkdtemp(join(tmpdir(), "vfx-review-import-")), execute = promisify(execFile);
  try {
    await writeFile(join(root, "review.zip"), plain);
    await execute("python3", ["-c", 'import sys,zipfile\np=sys.argv[1]\nwith zipfile.ZipFile(p+"/review.zip") as z:\n n="ATOMIVID-apertura-nativa-revision.mp4"\n assert z.getinfo(n).file_size < 30*1024*1024\n open(p+"/native.mp4","wb").write(z.read(n))', root]);
    const bytes = await readFile(join(root, "native.mp4")), sha256 = hash(bytes);
    if (sha256 !== review.reviewedOpeningSha256) throw new Error("REVIEW_FILE_CHANGED");
    const assetPath = `${job.id}/review/${sha256}.mp4`, bindings: ReviewBinding[] = [];
    for (const scope of review.scopes) {
      const gate = jobGates(job, scope.environmentId);
      const binding: ReviewBinding = { ownerId: job.ownerId, environmentId: scope.environmentId, stage: "integration",
        planHash: gate.planHash, artifactSha256: scope.integrationPixelSha256, assetPath, sha256,
        startFrame: scope.startFrame, endFrame: scope.endFrame };
      if (!currentReviewBinding(binding, job)) throw new Error("REVIEW_VERSION_CHANGED");
      const measured = await execute("ffmpeg", ["-v", "error", "-i", join(root, "native.mp4"), "-vf",
        `select=between(n\\,${binding.startFrame}\\,${binding.endFrame - 1})`, "-vsync", "0", "-pix_fmt", "rgb24", "-f", "hash", "-hash", "sha256", "-"], { timeout: 120_000 });
      if (measured.stdout.trim() !== `SHA256=${binding.artifactSha256}`) throw new Error("REVIEW_PIXELS_CHANGED");
      bindings.push(binding);
    }
    const current = await ownedJob(supabaseJobStore(service), job.id, job.ownerId);
    if (bindings.some(b => !currentReviewBinding(b, current))) throw new Error("REVIEW_VERSION_CHANGED");
    await results.putBytes(assetPath, bytes, "video/mp4");
    if (hash((await results.getBytes(assetPath)) ?? Buffer.alloc(0)) !== sha256) throw new Error("STORAGE_VERIFY_FAILED");
    const prior = await results.getJson<unknown[]>(`${job.id}/review/bindings.json`);
    const retained = (Array.isArray(prior) ? prior : []).map(v => currentReviewBinding(v, current)).filter(b => b?.stage === "master");
    const masterSha = jobGates(current).artifacts.master;
    if (masterSha) {
      const master: ReviewBinding = { ownerId: current.ownerId, stage: "master", planHash: current.planHash,
        artifactSha256: masterSha, assetPath: `${job.id}/review/${masterSha}.mp4`, sha256: masterSha,
        startFrame: 0, endFrame: current.brief.frames };
      if (!currentReviewBinding(master, current)) throw new Error("MASTER_VERSION_CHANGED");
      const key = `vfx_review_upload_ticket:${job.id}:${masterSha}`;
      if (!await ledger.get(key)) {
        const { data: upload, error } = await service.storage.from("videos").createSignedUploadUrl(master.assetPath);
        if (error || !upload?.signedUrl) throw new Error("PRIVATE_UPLOAD_UNAVAILABLE");
        if (!await ledger.insert({ idempotencyKey: key, projectId: job.id, shotId: "master-preview-import",
          provider: "internal", model: "private-review-import/1", method: "private_media_upload", attemptKind: "review",
          reservedUsd: 0, committedUsd: 0, status: "COMMITTED", providerJobId: null,
          resultRef: JSON.stringify({ ownerId: job.ownerId, assetPath: master.assetPath, sha256: masterSha,
            signedUploadUrl: upload.signedUrl, createdAt: new Date().toISOString(), providerCalls: 0 }),
          updatedAt: new Date().toISOString() })) throw new Error("UPLOAD_TICKET_EXISTS");
      }
      const storedMaster = await results.getBytes(master.assetPath);
      if (storedMaster) {
        if (hash(storedMaster) !== masterSha) throw new Error("MASTER_STORAGE_CHANGED");
        const receiptKey = `vfx_review_media_verified:${job.id}:${masterSha}`;
        if (!await ledger.get(receiptKey)) await ledger.insert({ idempotencyKey: receiptKey, projectId: job.id,
          shotId: "master-preview-import", provider: "internal", model: "private-review-import/1",
          method: "private_media_import", attemptKind: "review", reservedUsd: 0, committedUsd: 0,
          status: "COMMITTED", providerJobId: null, resultRef: JSON.stringify({ ownerId: job.ownerId,
            assetPath: master.assetPath, sha256: masterSha, storageBytesVerified: true, approved: false,
            providerCalls: 0, approvalsUnchanged: true }), updatedAt: new Date().toISOString() });
      }
      retained.splice(0, retained.length, master);
    }
    await results.putJson(`${job.id}/review/bindings.json`, [...retained, ...bindings]);
    console.log("PRIVATE_REVIEW_LINKED; PROVIDER_CALLS=0; ADDITIONAL_USD=0; APPROVALS_UNCHANGED");
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(() => { console.error("PRIVATE_REVIEW_IMPORT_BLOCKED"); process.exitCode = 1; });
