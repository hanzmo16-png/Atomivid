/**
 * Luma free preflight: GET /credits only (read-only per the official SDK; creates no generation).
 * Never prints the key. Usage: LUMA_API_KEY=… npx tsx scripts/vfx/luma-preflight.ts
 */
import { lumaCreditsPreflight } from "../../src/lib/providers/vfx/luma";

lumaCreditsPreflight()
  .then((r) => {
    console.log(JSON.stringify({ preflight: r.authenticated ? "LUMA_PREFLIGHT_OK" : "LUMA_PREFLIGHT_UNAUTHORIZED", httpStatus: r.status, balanceUsd: r.balanceUsd ?? null, paidCalls: 0 }));
    if (!r.authenticated) process.exit(1);
  })
  .catch((e) => {
    console.error("LUMA_PREFLIGHT_FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
