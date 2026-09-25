# Customer journey polish — 2026-09-25

Branch: work/customer-journey-polish. Based on production branch 7741560.
No changes to Claude's visual selection branch or Work montage/audio branch.

## Ordered review and fixes

1. Journey: result page now offers configuration/review navigation for ready scripts and a history exit for pending requests. A confirmed-but-undispatched Long Form request has an explicit start button instead of looping configure → result → configure. Detail query now includes confirmation and recorded-audio fields. Configuration login preserves the destination. Creation notice no longer incorrectly tells an already-scripted documentary to generate its script again.
2. Modes: Cinematic plans with zero AI clips say images IA; strategy cards describe stock as stock, not historical archive. The confirmation copy acknowledges that the script already exists. Format is visible before confirmation. New-documentary guidance recommends a short first trial without changing allowed durations or billing.
3. Progress/recovery: queue copy makes no immediate-start promise, overall percentage is labelled stage-based estimation, returning to a visible tab refreshes status immediately, and manual refresh never initiates generation. Stale copy no longer claims proof of a stopped job. Exhausted attempts advise retaining the request for recovery instead of creating a replacement. Result errors link to existing history recovery controls; server guards are unchanged.
4. Delivery: shared player supports inline mobile playback, shows actual metadata after loading, reports playback failures and refreshes links. Requested duration is explicitly labelled. Server produces a separate download URL with Storage's download option after existing owner checks. Player is keyed by signed URL to clear stale local error/metadata state after renewal. Landscape detail view gets usable width.

## Verification / limits

- Six new server-rendered component regression tests cover navigation, confirmed-but-undispatched requests, completed videos, unavailable signed URLs, missing downloads and recorded-avatar labels.
- Existing ownership, history, progress and form tests remain in verification.
- No schema, price, subscription, generation, provider call or production deployment.
- Browser automation failed before opening the page (agent-browser daemon startup). Authenticated browser QA, mobile playback, loadedmetadata events and real Content-Disposition downloads remain to be checked in an operational browser.
- No output-size/bitrate promises: actual encoded quality is not in the request row. Resolution alone does not imply full-quality encoding.
- AI availability in the web plan does not prove worker credentials. Cross-environment capability confirmation remains a separate backend task.

## Next product designs (not implemented)

Storyboard preview: use v3 visual report, authenticated owner-only thumbnails, narration fragments, provenance, gaps and uncertainty. Review after resource acquisition but before final render; clearly disclose any asset costs already incurred. Approval must bind to the exact report/asset version, never a mutable list.

Replace one scene: version scene overrides, validate ownership/duration/provenance and budget, reuse narration and other assets. Preserve previous final video. A new render may still be needed; do not promise instant replacement or zero compute cost. Any newly generated resource needs an approved cost ceiling. Integrate only after Claude's v3 quality contract is stable.

Validation result: 1,173/1,173 unit tests passed, including 6 new regression cases. Typecheck, changed-file ESLint and git diff --check passed. Initial multimedia failures were resolved by running the package's normal postinstall through npm rebuild for ffprobe/ffmpeg (the earlier install had used --ignore-scripts); no application changes were needed for those failures.
