# Owner self-service and editorial quality — 2026-10-06

Status: implementation proposal based on the owner's latest direction and a production-code audit. This is not a deployed editorial engine and does not certify autonomous video quality.

## Product outcome

Hans creates through the ordinary application: topic, channel, language, desired duration range and maximum cost, then generates and downloads. Owner entitlement removes retail subscription/video-count restrictions for supported modes; supplier balances, budgets, reservations and idempotency remain mandatory. Show “Propietario — consumo de proveedores,” not infinite funds. Same generation pipeline as customers; customer billing/quota behavior needs separate tests.

Prefer a complete, engaging seven-minute story over a padded twelve-minute one. A shorter duration must be visible in the plan before paid narration/rendering; never silently alter an already confirmed duration or plan hash.

## Verified starting point

- Production commit 4906516c51a2edb944e4df7933940038ccddff94 includes the owner entitlement for visual, long_form and avatar. It also provides Command Center access and an owner billing view. Standalone podcast/audio publishing is not implemented.
- Owner access has been explicitly bound to the existing verified principal account through the server-only production setting. No fake Stripe subscription or retail charge is required.
- `documentary-script.ts` requests a narrative arc but checks duration and banned generic openings. It does not perform an independent semantic review of repeated promises or section-to-section progress.
- `script-quality.ts` can detect repeated literal sentences, but paraphrasing the same hook is a different problem. Do not claim a literal-duplicate check solves semantic repetition.
- The documentary form requires sources from the user. The parser stores supplied titles/references/notes; supplying a URL does not prove its contents were retrieved or verified. Automated research and claim validation are required for genuine self-service factual documentaries.
- Existing full-flow source tests include two outdated assertions (120-second maximum and a direct generator invocation without its supply wrapper). Owner entitlement/quota tests pass; this is not a completed browser-to-master acceptance test.

## Editorial pipeline proposal

1. **Research and evidence.** Retrieve relevant source content, record provenance and extracted claims, distinguish sourced material from inference and unverified allegations. Treat source pages as untrusted data. DULCE reconstruction must remain labeled as reconstruction; hypothetical Achilles/Genghis combat must not become a historical event. Insufficient evidence should shorten/reframe a story, not invite invented facts.
2. **Story design.** Generate a few concise approaches within one bounded planning call; select one by specificity, evidence, visual feasibility and the answer it can actually deliver. Define a central question, opening promise, the first concrete answer and the final resolution before drafting.
3. **Script.** Each section introduces information, changes an interpretation, creates a consequence or resolves a question. Returning to an earlier idea must add something material. Avoid repeatedly teasing the same inaccessible revelation. Use varied tension and quieter explanation; do not force a surprise on a rigid timer.
4. **Independent editorial review.** A separate bounded review pass cites exact passages with repetitive meaning, empty suspense, unsupported escalation, unnecessary recap, missing answers and weak transitions. Link each concern to a specific section and a proposed fix. Do not accept a self-awarded model score as proof of quality or predicted retention.
5. **Bounded revision and gate.** At most one targeted editorial revision in the initial design, reusing the existing total correction allowance instead of creating an unbounded duration/review loop. Recheck factual attribution, length and visual-plan consistency. If a hard issue remains, save the draft and explain the unresolved reason before spending on voice and images. Subjective suggestions should not repeatedly block usable scripts.
6. **Production and learning.** Map narrative turns to visual and sound changes within the authorized motion budget. Persist the script/reviewer/version/plan relationship. Associate actual audience-retention timestamps with script sections and traffic cohorts; propose improvements for subsequent videos without changing published masters or automatically spending on replacements.

## Acceptance cases

- Three differently worded “lower levels are classified” teases with no added evidence are flagged as one repeated promise; the remedy is new supported information or removal.
- A return to the same subject with contradictory evidence or a genuine consequence is allowed.
- The opening delivers something concrete within the first minute as an editorial target, not a claimed universal retention threshold. A ten-minute cinema opening is not a suitable pacing model for a seven-minute YouTube video.
- Important questions receive answers when evidence permits. Unknown answers are stated honestly rather than perpetually postponed.
- A strong shorter draft is offered at its honest duration, with a new estimate/confirmation if the previous plan changes.
- API failures or low balance produce a saved, recoverable state without duplicate charges or repeated manual approvals.
- A successful owner acceptance run begins in the application and reaches a playable final artifact without CLI imports, manually fabricated script-ready rows, provider job injection, or external editing by an assistant. Verify narration, actual opening motion, repeated ideas and delivery; passing unit tests alone is insufficient.

## Measurement and rollout

User reports 26 views and 1:39 average view duration on an initial upload; these figures were not independently queried during this audit. Average duration does not mean every viewer exits at 1:39 and cannot isolate the script from audience targeting, title/thumbnail expectations or pacing. Use the friend's specific repetition report as a test case now; use retention curves as accumulating evidence later.

Official reference: https://support.google.com/youtube/answer/9314415?hl=es (read 2026-10-06). YouTube discusses first-30-second retention, expectation match, dips and replays; highlighted key moments require at least 60-second videos and 100 views. This threshold is a feature requirement, not statistical proof of success or failure.

Roll out editorial changes first on new owner-created drafts. Preserve DULCE I and Thermopylae approved masters. Keep the Salamis, DULCE II and Achilles/Genghis slate; do not silently rewrite confirmed plans, change narration providers, increase clip quotas or recharge accounts. Measure cost and review usefulness before extending the workflow to customer generation.
