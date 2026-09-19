# Private HeyGen migration

HeyGen is the primary avatar provider. Global avatar mode stays disabled; the ordinary render workflow cannot enable it. A separate owner trial workflow selects one pre-existing source request by its established digest, verifies ownership, consent, private buckets, exact photo/audio integrity against its original deterministic preparation ID, audio decoding and duration.

Preparation creates a deterministic separate HeyGen request, verifies the copied bytes and does not contact HeyGen. Existing D-ID attempt locks and history are preserved. Generation requires explicit workflow action, an unexpired authorization window, a pristine request, a private create-only lock and database compare-and-set. It uses the same production avatar pipeline. Any failure stops; no automatic retry or reset is provided. A private report records the wallet before/after and outcome; public workflow output does not include media, credentials or balances.

The HeyGen adapter uploads photo/audio assets and calls `POST /v3/videos` with `type=image` and `audio_asset_id`. It deliberately omits `engine`. It decodes the full original recording to PCM WAV without trimming, voice substitution or speed changes. It persists `data.video_id` before polling, downloads the completed result, and stores it in the owner's existing private video flow. Retrieval never creates a new job. Free-form provider failures are saved privately; public errors contain only bounded category/field tokens.

Required worker secret: `HEYGEN_API_KEY`, alongside existing Supabase secrets. Key expiry must be managed; an expired/missing key fails visibly. No paid plan, purchase or automatic top-up is enabled by this change.

Official API contract: https://developers.heygen.com/audio-to-video and https://developers.heygen.com/assets . Real generic-sample verification succeeded before this integration. Owner-media generation remains pending until its guarded workflow completes; never infer success from unit tests.
