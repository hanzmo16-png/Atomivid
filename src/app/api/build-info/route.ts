import { READ_ONLY_INSPECTION_VERSION } from "@/lib/mystery-shopper/quality-loop/readonly-inspection";
/** Public immutable build identity only; never config, users, tokens or financial data. */
export const dynamic='force-dynamic';
export async function GET(){
 const sha=process.env.VERCEL_GIT_COMMIT_SHA;
 return Response.json({sha:sha&&/^[a-f0-9]{40}$/.test(sha)?sha:null,readOnlyInspectionVersion:READ_ONLY_INSPECTION_VERSION},{headers:{'Cache-Control':'no-store'}});
}
