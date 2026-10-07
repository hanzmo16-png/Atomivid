# Creative direction v2 — 2026-10-06

User-authorized adaptation of the supplied Grok showrunner prompt for Atomivid's existing self-service documentary flow. Extends v1; no new generation or publication occurs during rollout.

## Adopted

- A compact creative brief: audience, emotional promise, belief to challenge and final feeling.
- Seven angle proposals with distinct premises, narrative devices, hooks and genericity risks. Three distinct finalists; the selected angle must be one of them. At least four narrative device families are explored. No numerical retention prediction or multiplied pseudo-objective score.
- A topic-substitution test, a topic-specific signature detail and a separate critic that evaluates the actual narration against those intentions.
- Up to five recent documentary scripts from the authenticated account, queried through its session client and explicit user_id filter. Only bounded topic/opening/ending/structure/device/promise summaries enter model context. This is account-level history, not YouTube-channel history. Videos created externally and never stored as app requests are not silently claimed to be remembered.
- Writer and critic receive the same history snapshot. Without history the writer must not claim to have avoided earlier scripts. With history it records three concrete patterns it avoids. A verbatim opening copy is rejected in code; paraphrases/template similarity require the critic's semantic judgment.
- The old fixed chapter sequence is removed from the writer instructions. Timing guidance is flexible: a concrete opening, an early reward, a larger payoff, and new reasons to continue around every 60–90 seconds. No additional paid motion quota is implied.
- Spoken phrasing, one marked shareable line, at most one declared comment invitation and one closing CTA; three literal passages identified for preservation during editing. Marks are separate metadata, not voice content. The critic checks the whole narration for undeclared engagement bait and dishonest promises.
- Seven proposals, chosen angle, reasoning, signature detail, shareable line, weakness and edit notes are visible in production configuration. Per-block timing estimates derive from draft word counts, clearly distinguished from final audio/montage chapters.
- New reports use editorial-v2. Existing editorial-v1 and legacy scripts remain compatible. The v2 report must have valid creative metadata before confirmation/render/worker acceptance.

## Deliberate adaptations

This is not a literal generic prompt pasted over the product. The current flow stays faceless documentary with its language, sourcing and factual safeguards; fiction is not silently relabeled as documentary. The existing thumbnail/cover renderer and publication package are not replaced with five titles, three generated images or fabricated chapter timestamps. The proposed script title is checked by the critic and displayed, but user-edited final packaging is not claimed to have received that review. The preservation notes are editorial recommendations, not new automatic image/render operations.

Novelty must not force manufactured evidence, arbitrary twists or a mechanical rotation that breaks an episode's continuity. Asking for a real creator anecdote is represented as an honest evidence gap, never a fabricated personal story. No promises about real retention, comment rates or audience growth are made.

## Cost and recovery

No extra provider stage: the direction is emitted in the existing writer response and evaluated by the existing critic. Normal path remains research + writer + critic; at most one rewrite and one final review. More context/output can consume more tokens within unchanged existing limits. The same SDK retry policy, durable accounting, quotas, reservations and provider/global caps apply. No paid API calls or media generation during implementation/tests.

History/version become part of the documentary scope. Identical inputs plus the same history snapshot reuse committed calls. A legitimately changed history changes the creative request; no automatic retry or reconciliation bypass was added.

## Validation

TypeScript and 54 dedicated editorial tests pass, including eight new cases for angle selection/diversity, literal edit marks, unresolved placeholders, bounded correction, semantic-clone/title findings, absent history, identical writer/critic history, owner scoping, read failure before spend, bounded summaries and calculated timing. Full unit suite: 1,335 passing; spending suite: 73 passing. Tests use synthetic writer/critic outputs: these prove contract behavior, not live model creativity.

A read-only production query confirmed the authenticated owner's documentary history exists (currently Salamis). No historical scripts, approved masters, database schema, balances or ownership were changed.
