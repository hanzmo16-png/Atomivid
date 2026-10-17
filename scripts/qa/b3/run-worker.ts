/**
 * T-34 B3 — runs ONE render attempt in a separate process with its OWN environment (the "Actions" side of the split),
 * against the LOCAL Supabase only. Usage: node --import tsx scripts/qa/b3/run-worker.ts <requestId> <attempt>
 */
export {}; // module scope: avoids colliding with other scripts' global `main()`.

async function main() {
  const [requestId, attempt] = process.argv.slice(2);
  const sb = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!requestId || !attempt || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(sb.replace(/\/$/, ""))) {
    console.error("b3 worker: REFUSED (needs requestId, attempt and a local Supabase URL)");
    process.exit(2);
  }
  const { runRenderJob } = await import("../../../src/lib/video/run-job");
  try {
    await runRenderJob(requestId, Number(attempt));
    console.log("b3 worker: attempt finished");
  } catch (e) {
    console.log("b3 worker: attempt failed:", e instanceof Error ? e.name : "error");
    process.exitCode = 1;
  }
}
void main();
