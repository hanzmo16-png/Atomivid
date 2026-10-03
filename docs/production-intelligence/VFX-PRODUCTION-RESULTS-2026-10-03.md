# VFX preparation result — 2026-10-03

Status: PARTIAL_MATERIALS_REVIEW_REQUIRED. Not production-ready or fully certified.

The owner explicitly approved the three independent directions at 17:49:10 UTC: NYC night practicals, beach soft daylight, moon hard sun with a distant uncrewed rover. Authorization covers one FLUX.2 Pro background per environment, maximum $0.09 for this batch. No motion, master render, or deployment was executed.

| Environment | Durable result | Ledger | Review |
| --- | --- | --- | --- |
| NYC | PNG stored, SHA256 e8c3d0aa4033b9cb116cd952aede6f094fd08f23e2b47c93bc2d733932a65f23 | $0.03 committed using published-rate basis | Visual approval required |
| Beach | Accepted job 9461fdbd-c308-4d7e-9607-24d11978912f, result polling now HTTP 404 | $0.03 reserved, settlement pending | Blocked; never resubmitted |
| Moon | PNG stored, SHA256 f0e4568511b7108381e39bb3e2d2611ab37fde36c6d087b194055553bb113d7c | $0.03 committed from provider usage | Visual approval required; Director artifact registration awaits prior missing styleframe |

The previous adapter reconstructed the polling URL and failed to persist the provider receipt. This was corrected: accepted job ID, exact returned polling URL, and reported cost are stored atomically; subsequent runs resume the same request. Legacy beach receipt was reconciled against the documented regional result API, which returned Ready, but its download failed and later polling returned HTTP 404. Expiration is a possible cause, not confirmed. Recovery requires BFL to restore the existing job/result or explicitly reconcile it; a new paid beach request is not automatically authorized.

The original private source remains unchanged: SHA256 5d6e025f43a0f27e3835330edd79dcef46742a7e565ecb158cffefaf7f990e7b, 1080x1920, 30 fps, 150 frames. No original source was exported by this branch's workflows. Only generated background PNGs were exported for review.

Validation: 41 scoped tests, type generation, TypeScript checks, and lint passed in GitHub Actions run 37144085322. Real BFL image submission, durable receipt, download, storage, and cost settlement succeeded for Moon. The material batch correctly reports failure because Beach remains blocked. The physical matte, per-world relight/composition, visual approvals, and final cut/grain render remain unverified; passing core tests does not certify those outputs.

Changes are on codex/vfx-sequence-compositor, with deployment disabled for that branch. Do not merge or deploy this as a fully closed production certification.


## Authorized repair and native-material preparation, 19:05 UTC

The owner authorized continued execution at 18:44:48 UTC. A fresh poll confirmed the original beach request still returned HTTP 404. It was marked RECONCILIATION_REQUIRED, with its $0.03 reservation retained. A zero-cost rejected-defect record binds that exact provider job, owner, original operation, and explicit authorization. Exactly one same-prompt FLUX.2 Pro replacement was permitted, capped at $0.03. Its result is stored and committed with provider-reported cost $0.03 and SHA256 ccfe555d6232fd646bc218881b232cb963388ce10f5f7be743e06fd7cd1b1fcc. A third submission or changed prompt remains blocked. The generation envelope is now $4.80 including the unreconciled original reservation, not a falsely asserted refund.

All three actual styleframes are now registered in the Director. NYC and Moon visual approvals have been imported as scoped styleframe reviews bound to their exact measured PNGs. Beach is not visually approved. Trusted task selection permits an independent world task only after its own dependencies and review gates; the master still requires every world. No plan reset occurred.

Native 1080x1920 RVM matting succeeded for all 150 source frames using official RobustVideoMatting v1.0.0 ONNX weights SHA256 88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828. The full matte is stored in private storage as fifteen hash-bound ten-frame chunks. Selected original/matte controls were AES-256-GCM encrypted before export; no clear original-person images were uploaded to public GitHub artifacts. The delivery key remains in the service-only ledger. Workflow 37146504643 succeeded. The previous proof packaging exceeded the review capsule size guard; its retry reused all three committed BFL results and incurred no new generation cost.

Three still compositor controls were rendered locally from source frames 25, 75 and 125. Their source and mask fingerprints, approved/review-required plate fingerprints, proposed grade fields, and output fingerprints are in VFX-MATERIAL-COMPOSITE-PROOF.json. Every solid source pixel matches its independently proposed frozen grade exactly. No geometry was warped and no grain was added. These are static controls, not motion clips, native 1080 final generated plates, integration approval, or a certified physical relight. The proposed gain/bias fields and extra lens blur require review; realistic hard-sun shadows and glasses reflections remain integration concerns. A suspected background strip at the shirt edge was checked at enlarged source/matte detail and proved to be part of the original shirt, so no destructive mask correction was applied.

Validation: 43 scoped TypeScript tests, typecheck, lint, and the five deterministic pixel tests passed. Official LTX docs were rechecked: fixed six seconds at 25 fps, silent generation, $0.09/s Fast 720 and $0.17/s Pro 1080 remain supported. Forecast remaining motion generation: $1.62 preview plus $3.06 final, $4.68 total. Authentication was verified by the read-only provider workflow; the most recent owner-supplied LTX balance remains the $21.25 console evidence, not a fabricated live API balance.

Next gates: owner visual review of Beach, then real LTX movement trials and motion review, native 1080 final plates, per-world integration review and master QA. No LTX generation, Kling generation, master video or deployment occurred. Kling's existing generic adapter remains contract-unverified; it is not required to retain the original recorded person's movement and must not be described as fully integrated. Overall Director certification remains open.

## Approved motion trials — 2026-10-03

Owner approved the replacement beach and three still lighting treatments at 19:26:45 UTC. Three official LTX-2.5 Fast requests, one per world, were submitted through the write-ahead payment ledger: 6 requested seconds, portrait 720, 25 fps, no audio, $0.54 each. LTX delivered 153 frames/6.12 s. The retained first 150 decoded frames were encoded losslessly and checked against the raw decoded-frame SHA; no interpolation, upscale, or new provider call. Public review previews are compressed separately; the registered artifacts are the private lossless files.

New booked trial cost: $1.62 at the published request tariff, not a provider billing receipt. Total committed project ledger: $1.71, with an additional $0.03 original beach charge still held for reconciliation. Every recovery reused the three same provider IDs and incurred zero new submissions.

NYC motion rejected: a stationary facade drifts approximately 22 pixels by 5.9 seconds; camera and cable geometry change. Moon motion rejected: stationary terrain structure changes instead of only the rover. Beach has gentle waves and near-stationary sand; owner movement review remains pending. Exact rejection/artifact fingerprints are persisted in the durable director job. Existing approved direction/styleframes and still lighting treatments are retained.

Workflow 37148958794 succeeded in execution/registration; this is not visual approval. Durable job status is BLOCKED (rejected motion). No Pro call, integration, final master, merge or deployment occurred. The VFX Director is not certified 100% for production. No second paid trial is authorized by this contract.

## Fixed lunar flag amendment and proof

Owner replaced the rover with an ATOMIVID flag and authorized continuation at 20:23:17 UTC. One official FLUX.2 Pro edit used the existing lunar plate and the existing atom/wordmark reference. Operation op_03e4377e84b076613a0b5d2797f8069a, provider job 33253d93-7037-4e2b-9503-c71b2283df97: recovered after a download failure without another submission; COMMITTED $0.075, provider_usage. Raw 1088x1920 cropped four pixels per side to native 1080x1920; no resize/upscale. New material SHA f4e744686f63543070a497a733b310e136e96562d270433f7006d5a436050f6c. Visual approval remains pending.

Native still foreground proof preserves all solid subject pixels under the previously proposed frozen grade (delta 0). NYC and beach still proof hashes are unchanged. The lunar flag is visible above/right of the subject; real motion, edge, reflection and hard-sun integration review remain necessary.

Compositor supports an explicit fixed_lunar_flag only for Moon/hard-sun and with a fingerprinted approved file bound to project, source and material. Required moving plates remain the default; fixed flag requires exactly zero background motion and measurable original subject movement. Trusted artifact revision retains upstream and unrelated worlds, invalidates dependent integration/master, retains prior review audit and demands fresh approval. 24 related TypeScript tests and seven pixel tests pass; typecheck/lint pass. No Pro call, master, merge or deployment.

Total committed ledger now $1.785 plus original failed-beach $0.03 held; with two remaining $1.02 Pro finals the conservative project forecast is $3.855, within the existing $4.80 ceiling. Hosting/storage/tax are excluded.

## Actual five-second private opening review

Workflow 37152601595 succeeded. The approved original 150 source frames and measured native matte parts produced a 1080x1920@30, 150-frame, exactly 5.000-second silent proof. New NYC screen-region repair, actual beach movement trial and the fixed native lunar flag are cut at frames 50 and 100. No geometric warp, no grain, no audio or provider call in the proof. Subject frozen-grade interior difference is zero before encoding across 169,316,021 measured solid pixels. SHA bc0d686dc5bceb954b584cc7d9e8f44efcf6be99797c44508ee8d67705fa52ad.

Personal media was encrypted before the public GitHub artifact step; only the owner-controlled capsule was retrieved. Reviewed contact frames around both cuts and the late gesture: world lighting remains separate, camera geometry is fixed outside NYC screen regions, flag stays behind/right of the foreground subject. This is not physical hard-sun/reflection certification or final integration approval.

NYC/beach use 720 trial material deterministically resized for this preview. Native final Pro plates remain required after real motion approval; do not promote this proof to a final master. New lunar material visual approval is pending. Full campaign UI, voice, music, captions and closing remain outside this opening proof. No merge or deployment.

Final development checks: all 1,571 application unit tests and seven deterministic pixel tests passed, with typecheck and scoped lint clean. Fixed-flag world payment policy rejects new lunar image-to-video calls while preserving recovery of already accepted operations. Policy persistence is performed by the existing committed flag recovery, with no new provider submission.
