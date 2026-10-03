/** Dedicated host-controlled preparation entrypoint. No request body from browsers or models.
 * Requires existing owned job, current scoped reviews and frozen connection evidence.
 * Usage: VFX_PREPARATION_ENABLED=1 VFX_PREPARATION_MANIFEST=/trusted/file.json node --import tsx scripts/vfx/prepare-world-asset.ts
 */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {createServiceClient} from '../../src/lib/supabase/service';
import {supabaseJobStore} from '../../src/lib/production-intelligence/vfx-director/store';
import {ownedJob} from '../../src/lib/production-intelligence/vfx-director/jobs';
import {directorActor} from '../../src/lib/production-intelligence/vfx-director/access';
import {assertProductionConnections} from '../../src/lib/production-intelligence/vfx-director/production-preflight';
import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';
import {supabaseResultStore} from '../../src/lib/paid-calls/result-store';
import {gatedWorldAsset} from '../../src/lib/paid-calls/gated-world-assets';
import {officialWorldPort} from '../../src/lib/providers/vfx-worlds/official';
const Evidence=z.object({checkedAt:z.string().datetime(),connections:z.array(z.object({provider:z.enum(['bfl','ltx']),dns:z.boolean(),https:z.boolean(),authenticated:z.boolean(),creditsVerified:z.boolean()}))});
const Manifest=z.object({jobId:z.string().min(1),ownerId:z.string().uuid(),environmentId:z.enum(['nyc','beach','moon']),phase:z.enum(['styleframe','motion','final']),prompt:z.string().min(1),projectBudgetUsd:z.literal(4.77),maxCostUsd:z.number().nonnegative(),connectionEvidence:z.object({path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}),reference:z.object({path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),mimeType:z.enum(['image/png','image/jpeg'])}).optional()}).strict();
async function main(){
 if(process.env.VFX_PREPARATION_ENABLED!=='1')throw new Error('VFX_PREPARATION_DISABLED');
 const m=Manifest.parse(JSON.parse(await readFile(process.env.VFX_PREPARATION_MANIFEST??'','utf8')));
 const bytes=await readFile(m.connectionEvidence.path);
 if(createHash('sha256').update(bytes).digest('hex')!==m.connectionEvidence.sha256)throw new Error('VFX_CONNECTION_EVIDENCE_CHANGED');
 const evidence=Evidence.parse(JSON.parse(bytes.toString('utf8')));
 const age=Date.now()-Date.parse(evidence.checkedAt);
 if(age<0||age>60*60_000)throw new Error('VFX_CONNECTION_EVIDENCE_EXPIRED');
 assertProductionConnections(evidence.connections);
 const sb=createServiceClient(),user=await sb.auth.admin.getUserById(m.ownerId);
 if(user.error)throw new Error('VFX_OWNER_LOOKUP_FAILED');
 const actor=directorActor(user.data.user);
 const job=await ownedJob(supabaseJobStore(sb),m.jobId,actor);
 const reference=m.reference?{bytes:await readFile(m.reference.path),sha256:m.reference.sha256,mimeType:m.reference.mimeType}:undefined;
 const asset=await gatedWorldAsset({projectId:m.jobId,actorId:actor,job,ledger:supabaseLedgerStore(sb),results:supabaseResultStore(sb),port:officialWorldPort(),maxCostUsd:m.maxCostUsd,projectBudgetUsd:m.projectBudgetUsd,connectionsVerified:true},{environmentId:m.environmentId,phase:m.phase,prompt:m.prompt,reference});
 console.log(JSON.stringify({key:asset.key,model:asset.model,sha256:createHash('sha256').update(asset.buffer).digest('hex'),reused:asset.reused,costUsd:asset.costUsd,costBasis:asset.costBasis}));
}
main().catch(()=>{console.error('VFX_PREPARATION_BLOCKED');process.exitCode=1;});
