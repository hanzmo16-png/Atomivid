import test from 'node:test';import assert from 'node:assert/strict';import{audiovisualGate}from'../../../../scripts/mystery-shopper/video-podcast-mission';
const good={real:true,kill:true,stopped:false,ledger:{reservations:[],settlements:[]},quote:2.5,runCap:3};
test('AV paid gate requires real quote, switch, ledger, run and module room',()=>{
 assert.equal(audiovisualGate(good).ok,true);
 for(const patch of [{real:false},{kill:false},{stopped:true},{ledger:null},{quote:null},{quote:NaN},{quote:3.01},{runCap:2}])assert.equal(audiovisualGate({...good,...patch}).ok,false);
});
test('AV gate retains outstanding reservations and all historical spend',()=>{
 const r={key:'past',module:'video-podcast' as const,jobId:'fixture',reservedUsd:3,at:'fixture'};
 assert.equal(audiovisualGate({...good,ledger:{reservations:[r],settlements:[]}}).ok,false);
 assert.equal(audiovisualGate({...good,ledger:{reservations:[r],settlements:[{key:'past',spentUsd:.1,source:'fixture',at:'fixture'}]}}).ok,false);
 const other={...r,module:'youtube' as const,reservedUsd:6};assert.equal(audiovisualGate({...good,ledger:{reservations:[other],settlements:[]}}).ok,false);
});

import {defaultCatalog,missionById} from "../catalog";
test("AV worker mission exists before any browser or job reservation",()=>{const m=missionById(defaultCatalog(),"video-podcast-real");assert.equal(m.product,"video-podcast");assert.equal(m.requestedSeconds,60);assert.equal(m.auto,false);});
