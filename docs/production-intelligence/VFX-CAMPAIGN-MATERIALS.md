# Campaign material direction — 2026-10-03

Status: prepared direction, not generated or visually approved. Source measured by GitHub Actions run 37141516555: 1080×1920, 30fps, 150 frames, five seconds, no audio; SHA256 5d6e025f43a0f27e3835330edd79dcef46742a7e565ecb158cffefaf7f990e7b. Proposed hard cuts at frames 50 and 100 await direction review. No source video or frames are published by the metadata worker. Existing VFX Director production job query returned no rows; approval records are not invented from the merged PR.

## Shared contract

Hans, clothes, tattoos, watch, face and screen direction come from the original recording. Generated assets contain backgrounds only. Camera perspective and horizon must fit measured source optics and subject position. The three worlds have separate plates and separate lighting; transitions are hard cuts. Preserve lens blur; remove only added excess blur. Reject a night background that appears sharper than Hans. Grain is absent in every background and added once to the whole final frame. No upscale, reframing of Hans, optical motion interpolation, audio generation or extra provider.

## New York

Story: recognizable urban energy behind the same real person. Locked camera at the source eye height. Practical signage, illuminated windows and cool night ambient, restrained highlights. No people in the plate. Subject relight: cool fill and motivated practical rim, restrained enough to preserve skin and clothes. Lens focus stays on Hans; background detail is subordinate.

FLUX frame prompt (English): `A photorealistic background plate of Times Square, New York at night, vertical 9:16, street-level stationary camera at human eye height, natural perspective, luminous storefronts and illuminated signs with restrained highlights, cool night ambient and warm practical lights, an unobstructed foreground reserved for a separately composited person, subtle lens depth of field with the midground gently softer than a sharply focused foreground subject, clean digital image. Background only, no people, no silhouettes, no foreground character, no film grain. No artificial blur streaks or transition effects.`

LTX motion prompt: `Keep the camera position, perspective, geometry, horizon and night lighting of the supplied approved image unchanged. Animate only plausible small background activity: restrained electronic signage changes and distant traffic light movement. Preserve the empty foreground for compositing. No people appear. Continuous realistic motion for six seconds, no cut, no transformation, no daylight, no film grain, no audio.`

## Beach

Story: open tropical coast with the same person. Locked camera; measured source horizon. Soft daylight, pale warm sand, turquoise water and clear sky with slight haze. Empty foreground and no close objects crossing Hans. Subject relight: broad soft daylight, gentle warm bounce from sand and low contrast. Never reuse New York lighting.

FLUX frame prompt: `A photorealistic empty tropical beach background plate, vertical 9:16, stationary eye-level camera with natural perspective, pale warm sand in the foreground, turquoise ocean in the midground, a level horizon and bright sky with light atmospheric haze, soft daylight and gentle sand bounce, unobstructed central foreground reserved for a separately composited person. Background only, no people, no silhouettes, no buildings, no foreground character, no film grain, no artificial blur streaks.`

LTX motion prompt: `Preserve the supplied approved beach image, camera position, natural perspective, level horizon and soft daylight. Animate gentle small ocean waves and subtle distant clouds while keeping the empty foreground stable. No people or new objects appear. Six seconds of continuous plausible motion, no camera move, no cut, no transformation, no night lights, no film grain, no audio.`

## Moon

Story: unmistakable lunar setting with the same real person. Locked camera; pale regolith, sparse crater relief, black sky. Hard sun with one consistent shadow direction; almost no atmospheric fill. Earth's placement optional and subject to scale review. Subject relight must motivate hard sun without inventing geometric shadows on Hans that cannot be supported by measured relight data.

FLUX frame prompt: `A photorealistic lunar surface background plate, vertical 9:16, stationary eye-level camera with natural perspective, pale gray regolith, sparse shallow crater relief and distant lunar hills, an unobstructed foreground reserved for a separately composited person, black space sky without atmospheric haze, one hard sunlight direction producing crisp consistent terrain shadows, a small uncrewed lunar rover in the distant right midground with room to travel parallel to the horizon. Background only, no people, no astronauts, no foreground character, no film grain, no artificial glow or transition effects.`

LTX motion prompt: `Preserve the supplied approved lunar image, locked camera, terrain geometry, black sky and single hard sunlight direction. Animate only the small distant uncrewed rover rolling slowly across the right midground, with consistent ground contact and its own hard-sun shadow. The lunar terrain and camera stay fixed. Do not invent wind, floating dust, moving stars, atmospheric clouds or terrain deformation. No people appear. Six seconds, no camera orbit, no cut, no transformation, no film grain, no audio.`

The rover supplies observable physical background movement while Hans and the camera remain unchanged. Reject the motion if the rover deforms, floats, approaches the subject silhouette or fails the measured moving-plate threshold. No artificial camera movement is substituted.

## Preparation order and blockers

1. Measure original source; freeze source hash and exact three cut windows.
2. Prepare native source-aligned matte, clean room plate and each world's frozen relight data. Validate hair, glasses, arm/torso gaps, hands and contact.
3. Register a durable preparation job and measured direction artifacts. Human direction approval precedes paid styleframes. Current paid entrypoint requires an existing job; do not bypass it.
4. Generate exactly one FLUX frame per environment ($0.03 each) through the ledger, store actual bytes and fingerprint, inspect perspective/lighting/resolution and show for human review.
5. Approved frame is the sole LTX image reference. One Fast preview ($0.54) then, only after approval, one Pro final ($1.02), each six seconds, silent, per environment. Native 25fps is normalized deterministically to source 30fps only if source measurement confirms 30fps.
6. Validate each composite independently, obtain its visual approval, assemble by cut, grain once, technical/audio/caption QA and master review. A rejected defect blocks master; correcting beach retains unchanged New York reviews.

Base quote $4.77, not an all-in hosting/tax debit. BFL authentication and sufficient credits verified by run 37138370813; LTX authentication verified there and balance $21.25 verified by owner-provided console capture. No paid generation has occurred. Missing live job/material binding remain blocking, not approved assumptions.
