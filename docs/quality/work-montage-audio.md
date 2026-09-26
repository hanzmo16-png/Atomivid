# Long Form — Work montage/audio integration

Base: 770e4cb. Branch: work/long-form-montage-audio.

## Ownership and activation

This change touches the LongForm composition, its render input, and a new pure direction module. It does not change asset selection, production orchestration, shared audio-mix, Reel or Avatar. Existing callers retain legacy behavior. These controls do NOT automatically improve the already-completed Panama video. Claude's planner must explicitly provide directions and a sound cue sheet; production wiring remains a separate integration step.

## Contract

`LongFormShotScene.direction` (optional):
- `transition: {type: 'cut' | 'dissolve', seconds?: number}` describes the incoming transition. With a direction object, default is cut; without one, legacy 15-frame fades remain.
- `camera: 'still' | 'push' | 'pull' | 'left' | 'right'`. For stock video prefer still; apply camera movement to images only when editorially useful.
- `mediaStartSeconds`: offset into the source video. Validate the source is long enough for scene + dissolve tail BEFORE rendering; this module does not probe media.

`RenderLongFormDocInput.soundCues` passes unchanged to the composition:
- `undefined`: legacy musicUrl bed.
- `[]`: explicitly no background sound (voice stays).
- Cue fields: id, src, role (music/ambience/effect), startSeconds, endSeconds, optional sourceStartSeconds, gain (0..2), fadeInSeconds, fadeOutSeconds, loop (default false).
- Explicit cues REPLACE the legacy music bed to avoid double music.
- Times are absolute documentary seconds, except source offsets. Loop envelopes extend over the cue, not restart with each loop.
- Only already-authorized/licensed resources; caller owns durable storage, source duration validation, rights metadata and URLs lasting through render.
- All cues duck under voice. Music can rise inside measured narration gaps. Aggregate background amplitude cap 0.28 is not a loudness/true-peak guarantee. Keep existing mastering and measure final audio.
- Narration is never reordered or regenerated.

## First-minute Panama edit brief (provisional boundaries)

Align boundaries to the stored word timestamps; the following is an editorial structure, not invented exact transcription.

| Approximate span | Purpose | Visual treatment | Sound intention |
|---|---|---|---|
| 0–8 s | Scale of digging through terrain | Strong relevant wide shot, then detail; direct cut | Restrained impact and low tension bed |
| 8–18 s | Human difficulty and humid terrain | Distinct contextual labor detail; subtle push on stills | Quiet ambience; voice foreground |
| 18–28 s | Geographic problem | Verified map with clear labels; no fictitious geography | Thin out texture to help explanation |
| 28–40 s | Modern achievement contrasted with origins | Relevant working canal footage; avoid extra zoom on moving footage | Broaden music gently |
| 40–60 s | Transition toward earlier failure | Historical material or disclosed reconstruction | Shift to tension; short breathing space only where narration permits |

Use the existing narration as timing authority. Do not insert silences by cutting spoken words. A different narration requires a separately approved change and provider budget.

## Quality gate for the joint 45–60-second sample

- Unique, relevant resources, independently checked against narration/place/period.
- Zero automatic recurring title cards; any text serves one concise purpose and is readable on a phone.
- Intentional cuts; dissolves used selectively. No black flashes at boundaries.
- Real movement and still-image camera movement reported separately.
- No missing audio resources, accidental loop-envelope resets or overlapping legacy music.
- Spoken words remain clear; measure loudness and true peak after mastering, then listening review by Hans.
- Show before/after at matched narration timestamps. Technical tests are not editorial approval.

## Tests

Run `node --import tsx --test remotion/long-form-direction.test.ts remotion/long-form-independence.test.ts remotion/audio-mix.test.ts`.
Also run route type generation and typecheck in fresh clones (`npx next typegen && npm run typecheck`).

The render smoke test uses synthetic colored SVGs and tones, not production footage or a claim of improved documentary quality. A real sample still requires Claude's resource selection and the licensed audio cue assets.

## Validation in Work (2026-09-25)

- 19 focused tests passed; lint and typecheck passed after `next typegen`.
- Remotion render smoke attempted, but local runtime failed at `os.networkInterfaces()` with `uv_interface_addresses ... Unknown system error 1` before rendering. Visual/audio render verification remains pending in a working renderer; do not declare this approved.
- Existing dependency warning: Remotion expects zod 4.4.3, repository installs 4.5.4. Dependencies unchanged in this patch.
