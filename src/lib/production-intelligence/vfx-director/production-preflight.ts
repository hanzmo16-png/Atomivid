/** Campaign-specific quote. Does not submit, enable providers or imply authentication. */
export const VFX_GENERATION_QUOTE = Object.freeze({
  checkedAt: '2026-10-03',
  worlds: ['nyc','beach','moon'] as const,
  flux: { provider:'bfl',sku:'flux-2-pro',width:720,height:1280,referenceImages:0,
    outputMegapixelsBilled:1,usdPerImage:0.03,source:'https://docs.bfl.ai/quick_start/pricing' },
  preview: { provider:'ltx',sku:'ltx-2-5-fast',width:720,height:1280,fps:25,
    seconds:6,audio:false,usdPerSecond:0.09,source:'https://docs.ltx.io/pricing' },
  final: { provider:'ltx',sku:'ltx-2-5-pro',width:1080,height:1920,fps:25,
    seconds:6,audio:false,usdPerSecond:0.17,source:'https://docs.ltx.io/pricing' },
});
export function campaignGenerationQuote() {
  const q=VFX_GENERATION_QUOTE;
  const entries=q.worlds.flatMap(environmentId=>[
    {environmentId,stage:'styleframe',provider:q.flux.provider,sku:q.flux.sku,maximumSeconds:0,usd:0.03},
    {environmentId,stage:'motion',provider:q.preview.provider,sku:q.preview.sku,maximumSeconds:6,usd:0.54},
    {environmentId,stage:'plate-final',provider:q.final.provider,sku:q.final.sku,maximumSeconds:6,usd:1.02},
  ]);
  return {entries,totalUsd:Number(entries.reduce((n,e)=>n+e.usd,0).toFixed(2)),
    calls:entries.length,includes:'one styleframe, one preview and one final per world',
    excludes:['rejected-generation replacements','credit top-ups','tax','currency conversion','hosting and storage'],
    status:'QUOTED_NOT_AUTHENTICATED',
  };
}
export type ConnectionEvidence = {provider:'bfl'|'ltx';dns:boolean;https:boolean;authenticated:boolean;creditsVerified:boolean};
export function assertProductionConnections(evidence: ConnectionEvidence[]) {
  for(const provider of ['bfl','ltx'] as const) {
    const e=evidence.find(e=>e.provider===provider);
    if(!e?.dns || !e.https || !e.authenticated || !e.creditsVerified) throw new Error(`VFX_CONNECTION_NOT_VERIFIED:${provider}`);
  }
}
