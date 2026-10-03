/** Read-only connectivity check. NEVER submits a generation or prints secrets. */
import {lookup} from 'node:dns/promises';
import {campaignGenerationQuote} from '../../src/lib/production-intelligence/vfx-director/production-preflight';
async function main() {
  const connections=[];
  for(const [provider,host,variable] of [['bfl','api.bfl.ai','BFL_API_KEY'],['ltx','api.ltx.io','LTX_API_KEY']] as const) {
    let dns=false,https=false;
    try {await lookup(host);dns=true; const response=await fetch(`https://${host}/`,{method:'GET',signal:AbortSignal.timeout(10000),redirect:'error'});https=response.status>0;} catch { /* Metadata only; fetch errors can include sensitive transport details. */ }
    connections.push({provider,dns,https,credentialPresent:Boolean(process.env[variable]?.trim()),authenticated:false,creditsVerified:false});
  }
  console.log(JSON.stringify({quote:campaignGenerationQuote(),connections,productionReady:false,
    blockers:['Official provider adapters not yet integrated','Authenticated account/credit checks required','25fps plate normalization to source 30fps required','Frozen relight and matte material required','Human world reviews required']},null,2));
}
main().catch(()=>{console.error('VFX_PREFLIGHT_FAILED');process.exitCode=1;});
