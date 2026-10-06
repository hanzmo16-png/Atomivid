import { AsyncLocalStorage } from "node:async_hooks";
import type { PaidOpStatus } from "@/lib/production-intelligence/ledger";

const step = new AsyncLocalStorage<{ calls: number }>();
export class DocumentaryStepYield extends Error {}
/** One NEW provider request per worker HTTP invocation. Cached responses are free. */
export function withDocumentaryStep<T>(fn: () => Promise<T>) {
  return step.run({ calls: 0 }, fn);
}
/** Must run BEFORE reserving/submitting. Unknown prior outcomes still reach the
 * ledger reconciliation gate, never a new provider request. */
export function admitDocumentaryCall(previousStatus?: PaidOpStatus) {
  const current = step.getStore();
  if (!current || (previousStatus && previousStatus !== "RESERVED")) return;
  if (current.calls >= 1) throw new DocumentaryStepYield();
  current.calls++;
}
