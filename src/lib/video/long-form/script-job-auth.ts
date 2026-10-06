import { createHmac, timingSafeEqual } from "node:crypto";
export const SCRIPT_JOB_PATH = "/api/internal/documentary-script";
export function scriptJobSignature(secret: string, jobId: string, timestamp: string) {
 // Domain separation: raw service credentials are never transmitted to this route.
 return createHmac("sha256", secret).update(`atomivid-documentary-worker-v1\nPOST\n${SCRIPT_JOB_PATH}\n${jobId}\n${timestamp}`).digest("hex");
}
export function validScriptJobSignature(secret: string | undefined, jobId: string, timestamp: string | null, signature: string | null, now = Date.now()) {
 if (!secret || secret.length<32 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(jobId)
   || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now-Number(timestamp))>300_000 || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
 return timingSafeEqual(Buffer.from(signature), Buffer.from(scriptJobSignature(secret,jobId,timestamp)));
}
