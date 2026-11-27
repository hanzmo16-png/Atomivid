import {test} from "node:test";
import assert from "node:assert/strict";
import {buildSentinelOverview, type SentinelSnapshot} from "./sentinel";
import {commandCenterSentinelSnapshot,commandCenterSentinelSource} from "./command-center-source";
const now=Date.parse("2026-11-26T12:00:00Z");
function observation(stale=false,reliability: SentinelSnapshot["reliability"]="provider_api"){const model=buildSentinelOverview({now,policies:[{provider:"recraft",unit:"usd",unit_cost_usd:1,enabled:true},{provider:"flux",unit:"usd",unit_cost_usd:1,enabled:false}],snapshots:[{provider:"recraft",unit:"usd",available:50,health:"OK",reliability,checked_at:new Date(now-(stale?300001:1000)).toISOString()}],operations:[],reservations:[],historySince:"2026-11-01T00:00:00Z",ledgerComplete:true,uncoveredProviders:["recraft"]});return{sentinel:{...model,accounts:model.accounts.map(a=>({...a,operationalLevel:a.level}))},observedAt:new Date(now).toISOString(),timezones:["UTC"]};}
test("Claude contract receives one fal wallet and null free/autonomy instead of recalculating partial coverage",()=>{
 const dto=commandCenterSentinelSnapshot(observation());assert.equal(dto.version,"resource-sentinel/1");assert.equal(dto.source,"sentinel-engine");assert.equal(dto.providers.length,1);assert.equal(dto.providers[0].provider,"fal");assert.equal(dto.providers[0].balance.value,50);assert.equal(dto.providers[0].free,null);assert.equal(dto.providers[0].autonomy.days,null);assert.equal(dto.providers[0].level,"UNKNOWN");assert.deepEqual(dto.providers[0].evidence.aliases,["recraft","flux"]);
});
test("five-minute stale API remains unknown in visual contract; no 24-hour promotion",()=>{const dto=commandCenterSentinelSnapshot(observation(true));assert.equal(dto.providers[0].balance.value,null);assert.equal(dto.providers[0].balance.status,"STALE");assert.equal(dto.providers[0].evidence.staleValue,50);});
test("source adapter refuses normal users before any privileged data-client construction",async()=>{let calls=0;const source=commandCenterSentinelSource({user:{email:"customer@example.test",email_confirmed_at:"2026-01-01"},env:{COMMAND_CENTER_ADMIN_EMAILS:"owner@example.test"},service:()=>{calls++;throw Error("no database");}});await assert.rejects(source.read());assert.equal(calls,0);});

test("derived estimates are never falsely labelled as a manual balance source",()=>{
 const dto=commandCenterSentinelSnapshot(observation(false,"derived_from_ledger"));
 assert.equal(dto.providers[0].balance.status,"ESTIMATED");
 assert.equal(dto.providers[0].balance.source,null);
 assert.equal(dto.providers[0].evidence.estimatedValue,50);
});
