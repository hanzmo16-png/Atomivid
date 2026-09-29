# The Iron Annals — Blind Project #001

The episode has not been chosen yet: `EPISODE_TOPIC = PENDING`. No baseline exists, nothing is sealed, and PI V1.1 has never seen this project (`piShadowRuns: 0`).

| file | role |
|---|---|
| `protocol.json` + `PROTOCOL-LOCK.json` | Pre-registered rules, locked by hash |
| `PROTOCOL.md` | Readable summary of the protocol |
| `state.json` | Chosen topic, seal flag and shadow-run counter |
| `baseline/human-baseline.template.json` | Human shot contract to fill in |
| `sealed/`, `shadow/`, `result/` | Created by the CLI, in that order and only once |

## After the user selects the topic
1. **Record the topic.** Run this only on the user's explicit instruction:
   ```bash
   npx tsx scripts/blind-project/cli.ts select-topic <THERMOPYLAE_LEONIDAS|POMPEII|FALL_OF_CONSTANTINOPLE_1453> user
   ```
   Commit the result.
2. **Write the editorial documents.** Put the research in `research/research.md`, the script in `script/script.md` and the human storyboard in `storyboard/storyboard.json`. Web, LLMs and sources may be used; this is editorial work, not PI.
3. **Fill in the human baseline.** Create `baseline/human-baseline.json` from the template, with every shot and every field. Do it without running or reading PI. Commit it.
4. **Seal.**
   ```bash
   npx tsx scripts/blind-project/cli.ts seal
   ```
   Commit `sealed/` and `state.json`. From here on, corrections go only through `amend`.
5. **Run the shadow.**
   ```bash
   npx tsx scripts/blind-project/cli.ts shadow
   ```
   This makes zero provider calls and runs only once. Commit the result.
6. **Evaluate the shadow.**
   ```bash
   npx tsx scripts/blind-project/cli.ts evaluate
   ```
   This gives the shadow-stage verdict.
7. **Produce and evaluate the final master.** After the authorized production and final QA, run:
   ```bash
   npx tsx scripts/blind-project/cli.ts evaluate final-truth.json
   ```
   The file holds `FINAL_USED_METHOD` and `userKept` / `userRequestedRegeneration` / `userReason` for each shot.
