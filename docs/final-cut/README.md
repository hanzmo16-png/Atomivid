# Final Cut Intelligence V1 / Editorial Quality Gate

Sits after Production Intelligence produced a master and before Distribution may treat it as FINAL. Additive over commit `01ae4e7`: PI V1.1 (frozen tree `fb24a402…a2cbef`), Production Core and YouTube Monitoring are imported, never modified.

```
PI -> MASTER (RENDERED) -> Final Cut: inspect -> classify -> AUTO_FIX / SMART_REPAIR / ESCALATE -> reinspect -> EDITORIAL_QA_PASS -> Distribution
```

## Modules (`src/lib/final-cut/`)
| file | role |
|---|---|
| `policy.ts` | `FINAL_CUT_POLICY_V1`: rhythm thresholds are the Production Core timeline rules (one source); audio targets are the existing mastering targets; opening, subtitle, auto-fix tolerances and confidence gates are data. |
| `edl.ts` | The inspected object: slots (kind/motion/visualKey/beat), speech, captions and MEASURED signals (null = not measured). |
| `inspectors/{visual,rhythm,audio,subtitles,opening}.ts` | Detectors with rule ids, time ranges, evidence and confidence. Semantic defects (deformed images, face changes, hands) come only from production QA evidence attached to a slot; the report lists what was not assessable. |
| `classify.ts` | Rule table -> AUTO_FIX / SMART_REPAIR / ESCALATE / NONE, then confidence and severity gates. Unknown rules escalate. |
| `inspect.ts` | Deterministic report with content-addressed issue ids and the input fingerprint. |
| `auto-fix.ts` | Pure, idempotent EDL operations (trim black/silence, shorten cards, transitions, camera removal, validated-asset substitution, loudness/true-peak/fade, caption retime/safe area). `renderOps` documents the ffmpeg intent; nothing is executed. |
| `smart-repair.ts` | RepairPlan (issue, range, proposal, provider, incremental cost, improvement, fallback, provenance impact) gated by Cost Engine reservation, Provider Capacity admission and Policy ceilings. `executeRepair` refuses anything not explicitly AUTHORIZED by a person with a reservation. |
| `gate.ts` | Editorial state machine (composed after the PI asset lifecycle) and `distributionEligible`: FINAL requires `EDITORIAL_QA_PASS` unless `FINAL_CUT_ENABLED=false`. |
| `run.ts` | Orchestrator; fetch disabled for the run; INSPECT_ONLY proves the input untouched. |
| `persistence.ts` + migration `0027` | Append-only inspections/issues/decisions, repairs with before/after master ids and authorization, `fc_master_metrics` for the learning loop. |
| `adapters/media.ts` | Local ffmpeg/ffprobe measurements (black, freeze, silence, loudness, clipping), all `-f null -`. |
| `adapters/storyboard.ts` | Edit-timeline EDLs from the two storyboard families ATOMIVID has produced (field families, not project names). |
| `scripts/final-cut/inspect.ts` | INSPECT_ONLY CLI: `--storyboard`, `--production`, optional `--media`, `--out`. |

## Learning loop: data model only
`fc_master_metrics(production_id, master_id, report_id, metrics)` stores the opening/editorial/technical metrics of the master that passed. It joins with `yt_video_links.project_id` and `yt_metric_rows` (retention `audienceWatchRatio`, `averagePercentageViewed`, views windows) by a HUMAN analysis. No code reads YouTube data to change thresholds; calibration stays a human decision.

## Retrospectives (INSPECT_ONLY, see `retrospective/`)
The historical masters are not in this environment (they live in Supabase Storage), so the retrospectives ran on the committed EDIT TIMELINES. That reveals what the edit plan encodes (rhythm, repetition, opening structure), not the pixels or the audio. To complete each retrospective on the rendered master:
- **Ocean:** `--storyboard docs/pi-exam/ocean-input/ocean-storyboard-001.v003.json --production ocean-deep-001 --media <Ocean master .mp4 from Storage>`; optional captions/speech timing JSON for the subtitle checks.
- **DULCE Part I:** `--storyboard content/long-form/dulce-part1/storyboard.json --production dulce-part1 --media <DULCE-Part-I-master.mp4, sha256 28c0e1b6…229841f>`.
