/** Controlled HTML fixtures in real Chromium; not a production/OAuth/provider certification. */
import test from "node:test";
import assert from "node:assert/strict";
import { inspectCampaign320SurfaceReadOnly } from "../../src/lib/mystery-shopper/v3/campaign-320-readonly-preflight";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- worker-supplied Playwright
const pw = await import(process.env.PLAYWRIGHT_MODULE || "playwright") as any;
test("Chromium fixture: direct Reel form needs no Reel label or optional avatar mode input", async () => {
  const b = await pw.chromium.launch({ headless: true, executablePath: process.env.E2E_CHROME });
  try {
    const c = await b.newContext({ baseURL: "http://fixture.invalid" });
    await c.route("**/*", (r: { fulfill(v: object): Promise<void> }) => r.fulfill({ contentType: "text/html", body: '<h1>Generar nuevo video</h1><div role="radiogroup" aria-label="Guion">Crea mi guion</div><label>Tema o instrucciones<textarea></textarea></label><div role="radiogroup" aria-label="Duración deseada">30s</div>' }));
    const result = await inspectCampaign320SurfaceReadOnly(await c.newPage(), "reels");
    assert.equal(result.verdict.state, "PASS"); assert.equal(result.observation.requiredVisible.Reel, true);
  } finally { await b.close(); }
});
test("Chromium fixture: audiovisual rollout warning stays BLOCKED", async () => {
  const b = await pw.chromium.launch({ headless: true, executablePath: process.env.E2E_CHROME });
  try {
    const c = await b.newContext({ baseURL: "http://fixture.invalid" });
    await c.route("**/*", (r: { fulfill(v: object): Promise<void> }) => r.fulfill({ contentType: "text/html", body: '<div data-testid="podcast-wizard" data-hydrated="1"><ol aria-label="Pasos"><li>Participantes</li></ol><button data-testid="modalidad-video" disabled>Disponible cuando se active el estudio (pendiente de autorización).</button></div>' }));
    assert.equal((await inspectCampaign320SurfaceReadOnly(await c.newPage(), "video-podcast")).verdict.state, "BLOCKED");
  } finally { await b.close(); }
});
