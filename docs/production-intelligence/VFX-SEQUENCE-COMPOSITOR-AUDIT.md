# VFX Director sequence compositor — 2026-10-03

Base: PR #29, 6f971c69ff2c5816690cfd91793d1c46debcd01e.
Status: implementation prepared locally; production readiness NOT certified.

## Implemented

Separate world executors consume exact source frame windows without geometric warping, mixed-world frames or lighting ramps. Supported pairs are NYC/night-practical, beach/soft-daylight and Moon/hard-sun. Operator-supplied spatial gain/bias fields freeze each light treatment; grading does not establish physical key-light accuracy by itself.

Source-aligned matte and frozen room clean plate provide conservative edge decontamination. Solid foreground pixels equal their frozen grade before encoding. Input SHA-256, native raster/fps/frame count, moving-plate measurements and interval durations are checked. Each world has its own configuration fingerprint. The existing beach-correction regression preserves unrelated NYC/Moon approvals. Existing jobs, campaign master and legacy executor remain untouched.

Cut master accepts only complete ordered frame coverage, actual reviewed integration asset IDs and hashes. No crossfade, per-world noise or added blur option exists. One optional grain pass acts on the full master. Durable reconciliation recovers only complete fingerprinted results; missing receipts remain blocked and changed output fails. Human review and delivery gates remain required.

Worker registrations are trusted server configuration. No provider integration, DB migration, publication or production activation was added.

## Required frozen material

Each world requires a moving plate already framed and focused at source raster/fps; source-aligned uint8 alpha (.npy, frames × height × width); room clean plate (.npy float RGB); frozen gain/bias fields (.npz, float height × width × 3). All files require measured SHA-256. Numeric files use allow_pickle=False. There are no default lighting, optics or matte assumptions.

Strict manifest kinds `world-composite` and `cut-master` are defined in sequence-compositor.ts. Configure a distinct executor for each world. Master segments must reference actual reviewed integrations. Direction, frozen styleframe and motion remain registered artifact proofs.

## Outstanding evidence

The new FFmpeg encode and assembly route has NOT run on campaign material: campaign rendering remains unauthorized. No measured three-world materials/looks were supplied to this checkout; no visual QA is claimed. Synthetic tests do not prove hair, contact shadows, lunar key shape, optical focus, encoded subject preservation or cinematic quality.

No end-to-end production worker/database run or deployment occurred. The existing NEEDS_MATERIAL record remains authoritative. The opening-only master is silent; established campaign assembly must retain approved UI, voice, music, subtitles and closing.

The branch is local, not pushed: this repository's Vercel integration can deploy pushed branches. No production or preview deployment was authorized.

## Verification

32 director tests; five pure pixel tests; TypeScript typecheck; ESLint; Next production build passed. Installed FFmpeg filters inspected without rendering. Full application suite: 1,557/1,557 passed (after repairing local FFprobe execute permission). Python syntax checks passed. Zero paid calls; no campaign render. Existing application tests can create disposable media fixtures.
