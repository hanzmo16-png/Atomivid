import { test } from "node:test";
import assert from "node:assert/strict";
import { withDocumentaryStep, admitDocumentaryCall, DocumentaryStepYield } from "./documentary-step";
import { guardPaidCall, paidCallKey } from "@/lib/paid-calls/gate";
import { memoryLedgerStore, ReconciliationRequiredError } from "@/lib/production-intelligence/ledger";

test("interrupted orchestration reuses paid stage, yields before a second reservation, then continues",async()=>{
 const store=memoryLedgerStore(), outputs=new Map<string,string>(); let calls=0;
 async function stage(n:number) {
  const spec={projectId:"test",shotId:String(n),provider:"anthropic",model:"fixture",method:"script",inputFingerprint:{n},reservedUsd:1};
  admitDocumentaryCall((await store.get(paidCallKey(spec)))?.status);
  return guardPaidCall(store,spec,{call:async()=>{calls++;outputs.set(String(n),`result${n}`);return {result:`result${n}`,costUsd:.01,resultRef:String(n)};},load:async ref=>outputs.get(ref)??null});
 }
 const pipeline=async()=>{await stage(1);await stage(2);};
 await assert.rejects(withDocumentaryStep(pipeline),DocumentaryStepYield);
 assert.equal(calls,1); assert.equal(store.ops.size,1);
 await withDocumentaryStep(pipeline);
 assert.equal(calls,2); assert.equal(store.ops.size,2);
 await withDocumentaryStep(pipeline);assert.equal(calls,2);
});

test("uncertain accepted request never gets repeated on worker resume",async()=>{
 const store=memoryLedgerStore();let calls=0;
 const spec={projectId:"test",shotId:"1",provider:"anthropic",model:"fixture",method:"script",inputFingerprint:{},reservedUsd:1};
 async function stage(){admitDocumentaryCall((await store.get(paidCallKey(spec)))?.status);return guardPaidCall(store,spec,{call:async()=>{calls++;throw new Error("connection lost");},load:async()=>null});}
 await assert.rejects(withDocumentaryStep(stage));
 await assert.rejects(withDocumentaryStep(stage),ReconciliationRequiredError);
 assert.equal(calls,1);
});
