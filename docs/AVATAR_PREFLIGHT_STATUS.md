# Avatar preflight — 2026-09-18

Latest user instruction: complete preflight only. Report exact D-ID consumption, current account/API credit balance and any extra charge/plan requirement, then wait for explicit approval in chat for ONE real generation. No purchases, plan changes, public access or generation authorized now.

## Confirmed

- Vercel deployment o36ccZuUDqKuD9grQ1z6pWBqu1uX, commit 2d0e30ebe13bf0d99842cfc97b8aa7b01f340338, now Ready / Production / Current and assigned to atomivid.vercel.app.
- Server route and Server Action require authenticated confirmed email matching server-only private owner configuration. No owner email committed.
- 32 focused tests passed: private owner gate, avatar pipeline ownership checks, single-attempt protection, recorded audio without TTS fallback, malformed/cross-owner/overlong recording rejection, and read-only/redacted D-ID access checks. Fixture/mocked provider tests, not real generations.
- Original local recording measured by ffprobe: 42.794 seconds, 699576 bytes. No transformation or trimming performed. Configured worker limit remains 45 seconds and AVATAR_MODE_ENABLED=false.
- Public request to preparation route requires login.

## Blocked / not yet verified

- Authenticated owner UI and actual upload end-to-end require owner login in the browser. No successful authenticated session established during this preflight.
- Current D-ID account/API balance, charge units and exact consumption are unverified. Do not substitute old trial screenshots or reference prices.
- GET https://api.d-id.com/credits is the official read-only balance endpoint (https://docs.d-id.com/reference/getcredits). Existing workflow only checks HTTP status and deliberately discards its body.
- Repository is PUBLIC: do not put personal photo/audio, account balance, secret tokens, signed URLs or credentials in repository or public workflow logs. Any future remote balance retrieval must return account data privately.
- Live regression checks of existing videos and Stripe still pending authenticated access. Do not generate an ordinary video merely as a regression test without approval for its provider consumption.
- Preparation stores files privately but does not create a renderable request; after explicit approval, private preparation must be associated with a request before controlled generation. Server decode/duration validation and private asset verification remain necessary.

## Next step

Complete owner login via supported secure browser authentication/manual handoff, verify private form and uploads, inspect actual D-ID credits privately, then present verified figures to owner and STOP for explicit approval. No real provider generation occurred.
