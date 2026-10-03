# VFX system closure audit — 2026-10-03

Status: NOT CERTIFIED FOR PRODUCTION. No new provider calls, render or deployment in this audit.

## Verified

Current checkout full unit suite: 1,568 tests passed, zero failed, 21.6 seconds. This verifies tested code paths, not deployed end-to-end production or visual quality. Existing three-world source, approved styleframes and still lighting treatments remain unchanged. Current motion artifacts were registered; NYC/Moon motion rejected; beach movement awaits owner review. Paid trial receipts remain $1.62 at published tariff; no repeat trial submitted.

## Blockers and proposed resolution

1. Motion is not constrained by prompt alone. NYC has stationary facade drift (~22 px by 5.9 s) and changing cable geometry; Moon changes terrain structure. Test a local correction on the already-paid previews, zero provider spend: stabilize rigid NYC background and constrain animation to explicit approved regions; evaluate Moon rover isolation against its approved fixed terrain. This is a proposed correction requiring real visual proof, not a claimed fix. If geometry cannot be preserved, keep that world rejected. Do not use Pro as another unapproved trial or substitute a still silently.
2. `gates.ts` checks actual artifact hashes and recorded reviews. It does not itself measure locked-camera drift or terrain deformation. Promote the measured motion checks into trusted preparation QA before motion approval; avoid treating average frame differences as proof of intended motion.
3. Web VFX orchestration is incomplete in this checkout. `src/app/api/admin/vfx-director/route.ts` supports owned read/review/replace-plan; the execution path is currently trusted scripts/worker. No VFX Director page/client integration was found in src. Build owner-only review/status and budgeted durable execution integration before claiming page-based VFX production ready. Existing ordinary video routes are a separate flow and have not been browser-certified by this audit.
4. LTX authentication is verified by its official upload handshake. $21.25 balance is owner console evidence, not a live API balance; preserve that distinction. Shared generic preflight requires creditsVerified and therefore cannot be described as ready from authentication alone.
5. Final plate normalization currently rejects durations over 6.04 s, while actual Fast deliveries were 153 frames/6.12 s. Consolidate a verified decoded-frame trimming path for final delivery tolerance before Pro execution; preserve native raster, no interpolation/upscale, and report actual raw delivery separately. No Pro delivery has been measured yet.
6. Physical composite/master has not run end to end on current moving native final plates. Still gain/bias approval does not prove hard-sun geometry, reflections, hair edges, contact, optics, or final grain. Keep independent integration reviews and one full-frame final grain pass.

## Release sequence

Zero-cost motion correction feasibility and QA first; exact corrected movement review next. Only after approval, existing authorized native Pro calls within the project cap. Then private three-world integration and cut master, actual optical/edge/lighting/technical review, and complete campaign assembly. Finish owner-only web production/review path and a controlled page-based test. Deployment is a distinct action; none performed here. Gradually expand to YouTube channel jobs after a real page-driven production and controlled recovery check.

## Acceptance

The owner can start and follow a job from the page; projected spend is shown before paid dispatch; ledger persists before every provider call; accepted requests recover without repeat charges; corrections affect only their environment; rejected visuals cannot reach a master; final reviewed artifact is delivered privately. A passed unit suite alone does not certify these live conditions.
