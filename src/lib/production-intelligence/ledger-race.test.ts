import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executePaidOperation,
  memoryLedgerStore,
  SubmissionInFlightError,
  type PaidOperation,
} from "./ledger";

const NOW = "2026-10-19T20:00:00.000Z";
const op = {
  idempotencyKey: "op_0123456789abcdef0123456789abcdef",
  projectId: "request-1",
  shotId: "avatar:create",
  provider: "heygen",
  model: "photo-asset",
  method: "create_avatar",
  attemptKind: "initial",
  reservedUsd: 0.25,
};

test("D-RACE: an observer never rewrites another execution's SUBMITTED row", async () => {
  const store = memoryLedgerStore();
  const submitted: PaidOperation = {
    ...op,
    status: "SUBMITTED",
    providerJobId: null,
    resultRef: null,
    committedUsd: null,
    updatedAt: NOW,
  };
  await store.insert(submitted);
  const writesBefore = store.writes;
  let providerCalls = 0;

  await assert.rejects(
    executePaidOperation(store, op, {
      async submit() { providerCalls++; return { providerJobId: "job-never" }; },
      async poll() { throw new Error("unreachable"); },
    }, () => "2026-10-19T20:30:00.000Z"),
    SubmissionInFlightError,
  );

  assert.equal(providerCalls, 0);
  assert.equal(store.writes, writesBefore);
  assert.deepEqual(await store.get(op.idempotencyKey), submitted);
});

test("D-RACE: a winner can still commit after a concurrent observer is blocked", async () => {
  const store = memoryLedgerStore();
  let release!: () => void;
  const providerStarted = new Promise<void>(resolve => { release = resolve; });
  let continueProvider!: () => void;
  const providerMayFinish = new Promise<void>(resolve => { continueProvider = resolve; });
  let providerCalls = 0;

  const winner = executePaidOperation(store, op, {
    async submit() {
      providerCalls++;
      release();
      await providerMayFinish;
      return { providerJobId: "job-1" };
    },
    async poll() { return { resultRef: "avatar:1", actualUsd: 0.25 }; },
  }, () => NOW);

  await providerStarted;
  await assert.rejects(
    executePaidOperation(store, op, {
      async submit() { providerCalls++; return { providerJobId: "job-duplicate" }; },
      async poll() { throw new Error("unreachable"); },
    }, () => NOW),
    SubmissionInFlightError,
  );
  assert.equal((await store.get(op.idempotencyKey))?.status, "SUBMITTED");

  continueProvider();
  const result = await winner;
  assert.equal(providerCalls, 1);
  assert.equal(result.status, "COMMITTED");
  assert.equal(result.providerJobId, "job-1");
  assert.equal(result.resultRef, "avatar:1");
});
