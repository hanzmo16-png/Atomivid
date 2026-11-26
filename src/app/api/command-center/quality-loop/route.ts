import { createClient } from '@/lib/supabase/server';
import { GitHubQueueStore } from '@/lib/mystery-shopper/quality-loop/github-store';
import { qualityHandlers } from '@/lib/mystery-shopper/quality-loop/admin';
export const dynamic='force-dynamic';
const handlers=qualityHandlers({
 auth:async()=>{const auth=await createClient();const {data:{user},error}=await auth.auth.getUser();return error?null:user;},
 queue:()=>new GitHubQueueStore('hanzmo16-png/Atomivid',process.env.GH_WORKER_TOKEN),
 deployedSha:()=>process.env.VERCEL_GIT_COMMIT_SHA,
});
export const GET=handlers.GET;
export const POST=handlers.POST;
