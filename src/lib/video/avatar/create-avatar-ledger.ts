/**
 * T46 D2: createAvatar under the paid-call ledger (Postgres), not only under the Storage 409.
 *
 * The photo claim (new-photo-claim.ts) is atomic only if the Storage service version is (v1.11.13 is not; the version
 * in production is not verified). The ledger's key is unique in pi_paid_operations and RESERVED→SUBMITTED is a
 * compare-and-set, so N concurrent submits of the same request reach the provider AT MOST ONCE, whatever Storage does.
 *   - a committed result is reused (no call);
 *   - an operation already SUBMITTED/uncertain is never resubmitted (ReconciliationRequiredError → the caller keeps the
 *     claim and reports «uncertain»);
 *   - only typed final refusals (isFinalAvatarCreationRejection) are settled as rejected.
 * The store is used WITHOUT the supply-envelope submit: there is no job envelope when the form is submitted, and the
 * atomicity needed here comes from the unique insert plus the CAS update.
 */
import { guardPaidCall, type LedgerStore, type PaidCallClassification } from "@/lib/paid-calls/gate";
import { isFinalAvatarCreationRejection, type ProviderAvatar } from "./new-photo-claim";

export function avatarCreationSpec(requestId: string, providerName: string, photoSha256: string) {
  return { projectId: requestId, shotId: "avatar:create", provider: providerName, model: "photo-asset", method: "create_avatar",
    inputFingerprint: { photoSha256 }, reservedUsd: 0 };
}

export async function ledgerGuardedCreateAvatar(ledger: LedgerStore, requestId: string, providerName: string, photoSha256: string,
  call: () => Promise<ProviderAvatar>): Promise<ProviderAvatar> {
  const store: LedgerStore = { ...ledger, submit: undefined };
  const guarded = await guardPaidCall<ProviderAvatar>(store, avatarCreationSpec(requestId, providerName, photoSha256), {
    call: async () => { const r = await call(); return { result: r, costUsd: 0, resultRef: `avatar:${JSON.stringify(r)}` }; },
    load: async ref => (ref.startsWith("avatar:") ? JSON.parse(ref.slice(7)) as ProviderAvatar : null),
    classify: (err): PaidCallClassification => (isFinalAvatarCreationRejection(err) ? { kind: "rejected_final" } : { kind: "uncertain" }),
  });
  return guarded.result;
}
