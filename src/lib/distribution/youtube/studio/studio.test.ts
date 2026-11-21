import {test} from "node:test";
import assert from "node:assert/strict";
import {localDateInput,ownedChannel,draftKey,validateDraft,parseDraft,durationSeconds,videoKind,imageUrl,type Draft} from "./model";
import {readStudio,StudioReadError} from "./read";
const cid="UC"+"a".repeat(22), vid="abcdefghijk";
const ready=[{id:"done",title:"Terminado",mode:"long_form"}];
const d:Draft={version:1,state:"draft",videoId:"done",title:"Título",description:"Descripción",tags:["oro"],privacy:"private",publishAt:""};
const channel={id:cid,snippet:{title:"Canal fixture",thumbnails:{default:{url:"https://yt3.ggpht.com/photo"}}},statistics:{viewCount:"35"},contentDetails:{relatedPlaylists:{uploads:"uploads-fixture"}}};
const call=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
test("valid draft, exact constraints, scheduling is preparation only",()=>{assert.deepEqual(validateDraft(d,ready,0),[]);for(const update of [{title:""},{title:"x".repeat(101)},{description:"x".repeat(5001)},{title:"<x>"},{tags:["x".repeat(501)]},{videoId:"foreign"},{privacy:"public",publishAt:"2026-01-01"},{publishAt:"invalid"}])assert.ok(validateDraft({...d,...update} as Draft,ready,0).length);});
test("corrupt/foreign draft states rejected and unknown sensitive fields stripped",()=>{assert.equal(parseDraft("{bad"),null);assert.equal(parseDraft(JSON.stringify({...d,state:"published"})),null);assert.deepEqual(parseDraft(JSON.stringify({...d,access_token:"MUST_NOT_SURVIVE"})),d);assert.notEqual(draftKey("a"),draftKey("b"));});
test("Shorts remain candidates without aspect ratio, durations parsed exactly",()=>{assert.equal(durationSeconds("PT1H2M3S"),3723);assert.equal(durationSeconds("broken"),null);assert.match(videoKind("PT30S"),/Posible/);assert.equal(videoKind("PT4M"),"Video largo");assert.equal(imageUrl("javascript:alert(1)"),undefined);assert.equal(imageUrl("https://evil.invalid"),undefined);});
test("provider uses GET only, token only in Authorization, pagination and no Analytics by default",async()=>{const urls:string[]=[];const fake:typeof fetch=async(u,init)=>{const url=new URL(String(u));urls.push(url.href);assert.equal(init?.method,"GET");assert.equal((init?.headers as Record<string,string>).Authorization,"Bearer fixture-token");assert.ok(!url.href.includes("fixture-token"));return call(url.pathname.endsWith("channels")?{items:[channel]}:url.pathname.endsWith("playlistItems")?{items:[{snippet:{resourceId:{videoId:vid}}}],nextPageToken:"NEXT"}:{items:[{id:vid,snippet:{title:"Real-shaped fixture"},contentDetails:{duration:"PT3M"},status:{privacyStatus:"private"},statistics:{viewCount:"7"}}]});};const r=await readStudio("fixture-token",cid,"PAGE",false,fake);assert.equal(urls.length,3);assert.match(urls[1],/pageToken=PAGE/);assert.equal(r.nextPage,"NEXT");assert.equal(r.videos[0].statistics.viewCount,"7");assert.equal(r.analytics.available,false);assert.ok(!JSON.stringify(r).includes("fixture-token"));});
test("quota, revoked token, forbidden, malformed JSON and network failure sanitized; zero retries",async()=>{for(const [status,reason,code] of [[401,"","reconnect"],[403,"quotaExceeded","quota"],[403,"forbidden","permission"],[429,"","quota"],[500,"secret-string","unavailable"]] as const){let calls=0;await assert.rejects(()=>readStudio("secret",cid,undefined,false,async()=>{calls++;return call({error:{errors:[{reason}]}},status);}),e=>e instanceof StudioReadError&&e.code===code&&e.http===(code==="reconnect"?401:code==="quota"?429:code==="permission"?403:502)&&!e.message.includes("secret"));assert.equal(calls,1);}await assert.rejects(()=>readStudio("secret",cid,undefined,false,async()=>{throw new Error("secret-in-network-error");}),/unavailable/);});
test("no owner-matching channel means no playlist/video reads",async()=>{let n=0;await assert.rejects(()=>readStudio("fixture",cid,undefined,false,async()=>{n++;return call({items:[{...channel,id:"foreign"}]});}),/permission/);assert.equal(n,1);});
test("invalid page/channel fail before transport",async()=>{let n=0;const f:typeof fetch=async()=>{n++;return call({});};await assert.rejects(()=>readStudio("fixture","evil",undefined,false,f),/invalid/);await assert.rejects(()=>readStudio("fixture",cid,"bad&escape",false,f),/invalid/);assert.equal(n,0);});
test("Analytics is explicit; absent rows remain absent, permission failure does not fabricate stats",async()=>{for(const status of [200,403]){let analytics=0;const f:typeof fetch=async(u)=>{const url=new URL(String(u));if(url.hostname==="youtubeanalytics.googleapis.com"){analytics++;return call(status===200?{columnHeaders:[{name:"day"}],rows:[]}:{error:{}},status);}return call({items:[{...channel,contentDetails:{}}]});};const r=await readStudio("fixture",cid,undefined,true,f);assert.equal(analytics,1);assert.equal(r.analytics.available,status===200);assert.deepEqual(r.analytics.rows,[]);}});

test("foreign, pending and revoked channels fail owner gate before token resolution",()=>{const c={channel_id:cid,owner_user_id:"owner",connection_id:"encrypted-connection",status:"connected",title:"Fixture"};assert.equal(ownedChannel("other",[c],cid),null);assert.equal(ownedChannel("owner",[{...c,status:"revoked"}],cid),null);assert.equal(ownedChannel("owner",[{...c,status:"pending"}],cid),null);assert.equal(ownedChannel("owner",[c],cid),c);});

test("saved UTC schedule restores local editable value without changing the instant",()=>{const iso="2026-12-01T14:30:00.000Z";assert.equal(new Date(localDateInput(iso)).getTime(),Date.parse(iso));assert.equal(localDateInput("broken"),"");});

// Synthetic refresh transport: never uses a Google account or production store.
import { studioAccessToken, studioOAuthConfigured } from "./access";
import { memoryYouTubeOAuthStore } from "../oauth-store";
import { encryptToken } from "../oauth";
const env={GOOGLE_OAUTH_CLIENT_ID:"fixture-client",GOOGLE_OAUTH_REDIRECT_URI:"https://example.invalid/callback",GOOGLE_OAUTH_CLIENT_SECRET:"fixture-secret",YOUTUBE_TOKEN_ENC_KEY:Buffer.alloc(32,7).toString("base64")};
async function fixtureStore(){const store=memoryYouTubeOAuthStore();await store.saveConnection("fixture-connection",encryptToken("fixture-refresh",env.YOUTUBE_TOKEN_ENC_KEY),[]);return store;}
test("refresh invalid_grant alone asks for reconnect; invalid client, quota and server failure do not",async()=>{
 for(const [status,error,code,http] of [[400,"invalid_grant","reconnect",409],[400,"invalid_client","unavailable",503],[401,"invalid_client","unavailable",503],[429,"rate_limit","unavailable",503],[500,"secret-provider-body","unavailable",503]] as const){
  let calls=0;const store=await fixtureStore();
  await assert.rejects(()=>studioAccessToken({store,env,fetch:async(_u,init)=>{calls++;assert.equal(init?.method,"POST");assert.ok(init?.signal);return call({error},status);}},"fixture-connection"),e=>e instanceof StudioReadError&&e.code===code&&e.http===http&&!e.message.includes("secret"));assert.equal(calls,1);
 }
});
test("missing config and corrupt envelope fail closed before transport; no false reconnect",async()=>{
 for(const config of [{},env]){const store=await fixtureStore();await store.saveConnection("fixture-connection","corrupt-envelope",[]);let calls=0;
  await assert.rejects(()=>studioAccessToken({store,env:config,fetch:async()=>{calls++;return call({});}},"fixture-connection"),e=>e instanceof StudioReadError&&e.code==="unavailable"&&e.http===503);assert.equal(calls,0);
 }
});
test("refresh network, malformed JSON and missing access token never reach resource reads or leak details",async()=>{
 for(const run of [async()=>{throw new Error("secret-network");},async()=>new Response("not json"),async()=>call({}),async()=>call({access_token:""})]){
  let calls=0;const store=await fixtureStore();await assert.rejects(()=>studioAccessToken({store,env,fetch:async()=>{calls++;return run();}},"fixture-connection"),e=>e instanceof StudioReadError&&e.code==="unavailable"&&!e.message.includes("secret"));assert.equal(calls,1);
 }
});
test("successful refresh stays server-side and does not change stored consent",async()=>{
 const store=await fixtureStore(),before=await store.getConnection("fixture-connection");let calls=0;
 assert.equal(await studioAccessToken({store,env,fetch:async()=>{calls++;return call({access_token:"fixture-short-lived"});}},"fixture-connection"),"fixture-short-lived");
 assert.equal(calls,1);assert.deepEqual(await store.getConnection("fixture-connection"),before);
});

test("OAuth readiness reveals only presence, requires all four fields and never claims validity",()=>{
 assert.equal(studioOAuthConfigured(env),true);assert.equal(studioOAuthConfigured({}),false);
 for(const field of Object.keys(env)){assert.equal(studioOAuthConfigured({...env,[field]:undefined}),false);assert.equal(studioOAuthConfigured({...env,[field]:"  "}),false);}
});
