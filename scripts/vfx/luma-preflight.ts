/**
 * Luma free preflight (Agents API): GET /files?limit=1 only — read-only, creates no file and no
 * generation. Checks authentication and access. Never prints the key.
 * Usage: LUMA_API_KEY=… npx tsx scripts/vfx/luma-preflight.ts
 */
import { lumaFilesPreflight } from "../../src/lib/providers/vfx/luma";

lumaFilesPreflight()
  .then((r: Awaited<ReturnType<typeof lumaFilesPreflight>>) => {
    console.log(JSON.stringify({ preflight: r.authenticated ? "LUMA_PREFLIGHT_OK" : "LUMA_PREFLIGHT_UNAUTHORIZED", httpStatus: r.status, filesListed: r.filesListed ?? null, paidCalls: 0, generationsCreated: 0 }));
    if (!r.authenticated) process.exit(1);
  })
  .catch((e: unknown) => {
    console.error("LUMA_PREFLIGHT_FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
