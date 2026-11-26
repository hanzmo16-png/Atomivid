import test from 'node:test';
import assert from 'node:assert/strict';
import {strictPrivateLedger} from './strict-private-ledger.mjs';
const bucket=(download,list={data:[{name:'reserve-one.json'}]})=>({list:async()=>list,download});
test('a listed unreadable reservation never disappears from spend',async()=>{
 for(const r of [{error:Error('offline')},{data:null}])await assert.rejects(strictPrivateLedger(bucket(async()=>r)),/ledger-read/);
});
test('unknown listing and truncated ledger fail closed',async()=>{
 for(const list of [{error:Error('offline')},{data:null},{data:Array(1000).fill({name:'reserve-x'})}])await assert.rejects(strictPrivateLedger(bucket(async()=>({}),list)),/ledger-list/);
});
test('every readable historical reservation and settlement is retained',async()=>{
 const r={key:'one',reservedUsd:3},s={key:'one',spentUsd:.4};
 const b=bucket(async name=>({data:{text:async()=>JSON.stringify(name.includes('reserve-')?r:s)}}),{data:[{name:'reserve-one.json'},{name:'settle-one.json'},{name:'STOP'}]});
 assert.deepEqual(await strictPrivateLedger(b),{reservations:[r],settlements:[s]});
});
