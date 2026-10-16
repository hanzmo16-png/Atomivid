# ATOMIVID simulator

Runs the real application adapters and render pipeline against local synthetic fixtures and in-process provider emulators. It does not certify real provider availability, balances, human voices, lip-sync or production account access.

## Short regression run

Use Node 22, `npm ci`, ffmpeg, ffprobe and `npx remotion browser ensure`.

```sh
npm run test:simulator
npm run simulate -- --mode=billing,voice,avatar,reel --out-dir=/tmp/atomivid-simulator
```

Use a clean checkout and keep output outside the repository. The simulator scrubs provider credentials from its process and intercepts non-local requests. Reports include each scenario, PASS/FAIL/NOT_VERIFIED, media hashes and an explicit zero-provider-spend control. CI runs this short set with no provider secrets.

## Optional Long Form run

`npm run simulate -- --mode=youtube --out-dir=/tmp/atomivid-youtube` renders a 600-second structural fixture. Add `--youtube-1080p` only for an explicitly requested performance run. These expensive CPU runs are not part of the short PR workflow. Prior results do not stand in for a new run.

Imported from audited Claude C1 (4bad791), including the C2 avatar scenario adjustment (27ec7d9) corresponding to the application fixes merged in PR #122. Historical C1 failures remain documented; no old evidence is relabeled as a passing current run.
