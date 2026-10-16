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

## Local browser interface (localhost only)

```sh
npm run simulate:ui            # http://127.0.0.1:4319
```

A page with three buttons — **Reel**, **Long Form**, **Avatar** — that launch the audited simulator above as a child process and show status, the PASS/FAIL table, the USD 0 control (QA-02), playable/downloadable fixture MP4s with SHA-256, and the reports. Every page, JSON response and download is marked `SIMULACIÓN / FIXTURE — NO ES PRODUCCIÓN REAL`.

- **Long Form** runs the Long Form pipeline tests (`src/lib/video/long-form/*.test.ts`); it does not render 600 s. The 600 s structural render is a separate, slow button that asks for explicit confirmation.
- Binds to `127.0.0.1` only, rejects other `Host` headers, serves files only from each run's own output directory, refuses to start under `VERCEL`, `NODE_ENV=production`, `ATOMIVID_RUNTIME` or `GITHUB_ACTIONS`, and starts children with a minimal environment (no provider keys). One run at a time; a second click while one is running is rejected.
- It is not part of the Next app and is not deployed. It does not use the app's authentication, Supabase, workers or `/api/generate/*`, and nothing it shows is a real production or a real account state.
- Results default to `$TMPDIR/atomivid-sim-ui` (override with `--root=`, which must be outside the repository).
