# YouTube read-only monitoring — go-live runbook

State after this mission: the code path is complete and tested offline (OAuth consent → callback → encrypted persistence → refresh → channel identification → health check → linkage → ingestion → snapshots). What remains is external: credentials, migrations authorization and one consent click.

## Diagnosis
```bash
npm run youtube:doctor -- [--connection <connectionId>] [--offline]
```
Output: `READY | BLOCKED_EXTERNAL | BLOCKED_CONFIG | BLOCKED_DATABASE | BLOCKED_AUTH | ERROR`. It never prints a secret value (the report is refused if one is detected).

| check | source of truth |
|---|---|
| OAuth client / secret / encryption key / redirect URI | env presence + shape only |
| migrations present / applied | repo files; `public._migrations_applied` (UNKNOWN when unreachable) |
| Data API / Analytics API reachable | unauthenticated GET, any HTTP answer < 500 = reachable |
| connection / scopes / token / refresh / channel | stored envelope, `scopes ⊆ {youtube.readonly, yt-analytics.readonly}`, refresh grant, `channels.list mine=true` |
| AUTO_PUBLISH disabled / Final Cut gate active | `distributionFlags`, `finalCutFlags` |

## Human actions to activate the real connection (exact)
1. Google Cloud Console: project with **YouTube Data API v3** and **YouTube Analytics API** enabled; OAuth consent screen; **OAuth client (Web application)** with authorized redirect `https://<domain>/api/distribution/youtube/callback`. Test users must include the channel owner while the app is unverified.
2. Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `YOUTUBE_TOKEN_ENC_KEY` (`openssl rand -base64 32`) in Vercel + GitHub secrets. Never in git.
3. Authorize applying migrations **0023–0028** (`scripts/apply-supabase-migration.ts`, see `supabase/migration-manifest.json`).
4. Signed in as the owner, `POST /api/distribution/youtube/connect` → open `url` → consent (read-only scopes only) → callback stores the encrypted refresh token and the channel row. Note the `connectionId`.
5. `npm run youtube:doctor -- --connection <id>` must print `READY`.
6. After a MANUAL publication: `prepareLaunchRecord` → `recordManualPublication` (attaches the video id, creates the link), then `npx tsx scripts/youtube-monitor.ts <channelId> <connectionId> --dry-run` and without `--dry-run` to persist rows + snapshots.

## Metrics
| metric | source |
|---|---|
| views, watch time, average view duration, average % viewed, likes, comments, subscribers gained/lost | Analytics API v2 (per window) |
| views / likes / comments counters | Data API v3 (snapshots for 24h/48h) |
| traffic sources | Analytics `insightTrafficSourceType` |
| audience retention | Analytics `elapsedVideoTimeRatio` |
| impressions, impressions CTR | **not exposed by the public APIs** → `manual_entry` only; never invented |

## Snapshots
T+24h and T+48h use the Data API counter taken within ±3 h of the window end (the scheduler must run near those times); T+7d and T+28d use Analytics day totals. Content-addressed by (channel, video, window); COLLECTED is immutable (also enforced by trigger). Failures keep the snapshot PENDING with the failure reason and attempt count.
