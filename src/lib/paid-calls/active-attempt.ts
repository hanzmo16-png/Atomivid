import type { LedgerStore } from "@/lib/production-intelligence/ledger";

/** The attempt that owns this paid call is no longer active (cancelled, closed or replaced): nothing was sent. */
export class AttemptNoLongerActiveError extends Error {
  constructor() {
    super("El trabajo ya no tiene una reserva activa. No se repetirá automáticamente.");
    this.name = "AttemptNoLongerActiveError";
  }
}

/**
 * Wraps a ledger so that every NEW submission first proves its attempt is still active (`check` throws otherwise).
 * The check runs right before the RESERVED → SUBMITTED write, i.e. before any provider is called: a cancelled Reel
 * stops between two paid calls of the same stage (e.g. one image per scene), not only at the next stage boundary.
 * Reads, results already paid and settlements of calls in flight are untouched. A failed check leaves the row
 * RESERVED (no charge), which a later attempt resumes normally.
 */
export function guardNewPaidCalls(ledger: LedgerStore, check: () => Promise<void>): LedgerStore {
  const guarded: LedgerStore = {
    get: (key) => ledger.get(key),
    insert: (op) => ledger.insert(op),
    update: (key, expected, patch) => ledger.update(key, expected, patch),
    async submit(op, at) {
      await check();
      return ledger.submit ? ledger.submit(op, at) : ledger.update(op.idempotencyKey, "RESERVED", { status: "SUBMITTED", updatedAt: at });
    },
  };
  if (ledger.listByProjects) guarded.listByProjects = (ids) => ledger.listByProjects!(ids);
  return guarded;
}
