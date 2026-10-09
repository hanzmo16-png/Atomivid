import { test } from "node:test";
import assert from "node:assert/strict";
import { reclaimUnsubmittedAvatarAttempt } from "./pipeline";

type Row = { avatar_generation_started_at: string | null; avatar_provider_video_job_id: string | null };
/** Minimal fake of the two tables the re-claim reads/writes; update applies only if every filter matches (CAS). */
function fake(row: Row, ops: { status: string; method: string; provider_job_id: string | null }[], staleRead?: Row) {
  const q = (table: string) => {
    const filters: [string, unknown][] = [];
    let patch: Record<string, unknown> | null = null;
    const b = {
      select: () => b, update: (p: Record<string, unknown>) => { patch = p; return b; },
      eq: (k: string, v: unknown) => { filters.push([k, v]); return b; }, is: (k: string, v: unknown) => { filters.push([k, v]); return b; },
      maybeSingle: async () => {
        if (table !== "video_requests") return { data: null, error: null };
        if (!patch) return { data: { ...(staleRead ?? row) }, error: null };
        const ok = filters.every(([k, v]) => !(k in row) || (row as Record<string, unknown>)[k] === v);
        if (!ok) return { data: null, error: null };
        Object.assign(row, patch);
        return { data: { id: "r" }, error: null };
      },
      then: (res: (v: unknown) => void) => res({ data: ops, error: null }),
    };
    return b;
  };
  return { from: q } as never;
}

test("intento rechazado antes de enviar (generate_video RESERVED, sin job): se puede reanudar", async () => {
  const row = { avatar_generation_started_at: "2026-10-08T23:54:20Z", avatar_provider_video_job_id: null };
  assert.equal(await reclaimUnsubmittedAvatarAttempt(fake(row, [{ status: "RESERVED", method: "generate_video", provider_job_id: null }]), "r", "u"), true);
  assert.notEqual(row.avatar_generation_started_at, "2026-10-08T23:54:20Z");
});

test("cualquier rastro de envío al proveedor mantiene el bloqueo (nunca un segundo video pagado)", async () => {
  for (const status of ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED", "COMMITTED"]) {
    const row = { avatar_generation_started_at: "t0", avatar_provider_video_job_id: null };
    assert.equal(await reclaimUnsubmittedAvatarAttempt(fake(row, [{ status, method: "generate_video", provider_job_id: null }]), "r", "u"), false, status);
  }
  assert.equal(await reclaimUnsubmittedAvatarAttempt(fake({ avatar_generation_started_at: "t0", avatar_provider_video_job_id: "job" }, []), "r", "u"), false);
  assert.equal(await reclaimUnsubmittedAvatarAttempt(fake({ avatar_generation_started_at: "t0", avatar_provider_video_job_id: null }, [{ status: "RESERVED", method: "generate_video", provider_job_id: "job" }]), "r", "u"), false);
  assert.equal(await reclaimUnsubmittedAvatarAttempt(fake({ avatar_generation_started_at: null, avatar_provider_video_job_id: null }, []), "r", "u"), false);
});

test("dos workers a la vez: solo uno gana (CAS sobre la marca anterior)", async () => {
  const row = { avatar_generation_started_at: "t0", avatar_provider_video_job_id: null };
  const ops = [{ status: "RESERVED", method: "generate_video", provider_job_id: null }];
  assert.equal(await reclaimUnsubmittedAvatarAttempt(fake(row, ops), "r", "u"), true, "worker A re-claims");
  const afterA = row.avatar_generation_started_at;
  // Worker B read "t0" before A wrote; its compare-and-set on "t0" must fail and leave A's claim intact.
  assert.equal(await reclaimUnsubmittedAvatarAttempt(fake(row, ops, { avatar_generation_started_at: "t0", avatar_provider_video_job_id: null }), "r", "u"), false);
  assert.equal(row.avatar_generation_started_at, afterA);
});
