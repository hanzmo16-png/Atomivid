# Distribution Intelligence V1 — YouTube foundation

**What.** `src/lib/distribution/youtube/`: CONNECT → READ → ANALYZE → PREPARE PACKAGING. Multi-channel from day one. **AUTO_PUBLISH = false** (typed as the literal `false`; no env can enable it).
**Why.** Prepare distribution without risking a channel: the user publishes manually in V1.

## Capabilities and scopes (least privilege)
| Capability | Scope | V1 |
|---|---|---|
| READ_CHANNEL | `youtube.readonly` | enabled |
| READ_ANALYTICS | `yt-analytics.readonly` | enabled |
| UPLOAD_PRIVATE | `youtube.upload` | behind `YOUTUBE_UPLOAD_PRIVATE_ENABLED=true` (off) |
| SCHEDULE / PUBLISH | `youtube.upload` | refused in code |

## Connecting a channel (to do together, not done yet)
1. Google Cloud: create a project, enable **YouTube Data API v3** and **YouTube Analytics API**.
2. OAuth consent screen: External, app name/logo/privacy policy/terms URLs, add the two read scopes; keep it in **Testing** and add the owner's Google account as a test user.
3. OAuth client (Web application); authorized redirect URI, e.g. `https://<app-domain>/api/distribution/youtube/callback` (route not built yet).
4. Secrets (server only): `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `YOUTUBE_TOKEN_ENC_KEY` (32 random bytes, base64: `openssl rand -base64 32`).
5. Flow: server builds the auth URL (PKCE S256, `state`, `access_type=offline`), the callback exchanges the code server-side, stores only the **AES-256-GCM encrypted refresh token** (`yt_oauth_connections`, no client RLS policy). Access tokens are minted on demand and never stored or sent to the browser.
6. Refresh lifecycle: tokens of apps in Testing expire after 7 days; a failed refresh marks the channel `error` → reconnect. Disconnect = `revoke()` at Google, then delete the envelope and set `status='revoked'`.

## Analytics ingestion
Only real API metrics: views, estimatedMinutesWatched, averageViewDuration, likes, comments, shares, subscribersGained, subscribersLost (Analytics v2, `dimensions=video`), audienceWatchRatio by `elapsedVideoTimeRatio` (retention), publishedAt (Data v3). Rows keep channelId, videoId, metric, value, window, source, collectedAt; `rowKey` = hash(channel, video, metric, window, dimension) → idempotent upsert. The DB rejects unknown metric names.

## Distribution Memory
Per channel (`DistributionMemory`, and RLS in `yt_*` tables: an owner reads only their channels). It observes topic, title structure, thumbnail metadata, duration, hook structure, retention, watch time. It makes **no** automatic decision; correlation is not causation. YouTube Analytics can never change Production Policy.

## Launch package
Titles, thumbnails, description, chapters (YouTube rules: first at 0:00, ≥ 3, ≥ 10 s apart), keywords, hashtags, playlist, pinned comment, end screen, short/teaser suggestions. The system proposes, the user approves; texts promising virality, views, CTR or monetization are rejected.

## Upload and Google audit (future)
Uploads through an **unverified / unaudited** API project are locked to **private** by YouTube. Path: manual publishing (V1) → private API upload for the owner's channel → Google OAuth app verification (sensitive scopes: `youtube.upload`) + YouTube API Services **compliance audit** (quota extension/audit form) → integrated publishing for customers. Checklist: public homepage, privacy policy and terms URLs; demo video of the OAuth flow; scope justification; data retention/deletion policy; branding; YouTube API Services Terms and Developer Policies compliance. Nothing has been submitted.

## How to test
`node --import tsx --test src/lib/distribution/youtube/youtube.test.ts` (tests 16, 17, OAuth, ingestion, package).
## Not implemented yet
API routes/UI for connect and callback; scheduled ingestion job; Supabase store adapters (tables in migration 0024, not applied); real OAuth (no credentials exist yet).
