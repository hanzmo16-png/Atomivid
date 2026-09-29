# ATOMIVID Command Center — UI contract (V0 foundation → V1 visual)

**Access:** owner/admin only (`isCommandCenterAdmin`: `AVATAR_PREPARATION_OWNER_EMAIL` or `COMMAND_CENTER_ADMIN_EMAILS`, confirmed e-mail). Normal users never see other users, global revenue/costs, provider balances, other jobs, other channels or internal health.

**Single data source:** `CommandCenterService.section(user, section, window)` (`src/lib/command-center/service.ts`), exposed at `GET /api/admin/command-center?section=…&window=…` (never cached). Sections: `overview`, `production`, `customers`, `costs`, `providers`, `youtube`, `system-health`. Windows: `TODAY`, `7D`, `28D`, `MTD`, `LIFETIME`.

**Metric semantics (must be rendered, not flattened):** `{ value, state: KNOWN | UNKNOWN | UNAVAILABLE, note }`. A real 0 is KNOWN; UNKNOWN = the source cannot tell; UNAVAILABLE = the source is missing. The UI never shows a 0 for UNKNOWN/UNAVAILABLE and never shows revenue (`mrrUsd` is UNAVAILABLE until Stripe reconciliation exists).

## Navigation (future V1)
```
ATOMIVID COMMAND CENTER
├─ Overview                       section=overview
├─ Production                     section=production
│   ├─ Reels                        byType.reel
│   ├─ Long Form                    byType.long_form
│   ├─ Avatars                      byType.avatar
│   ├─ TTS/Podcast                  byType.tts_podcast
│   ├─ Queue                        byState.queued / running / staleRunning
│   └─ Final Cut                    finalCut.{pending,inspecting,repairRequired,humanReview,pass,fail}
├─ Customers                      section=customers (users, subscriptions by status)
├─ Revenue                        UNAVAILABLE until Stripe (contract only)
├─ Costs                          section=costs (estimated / reserved / actual COGS; by provider, media type, production type)
├─ Providers                      section=providers (HEALTHY | LIMITED | INSUFFICIENT | UNKNOWN; balance only when provider-reported)
├─ YouTube                        section=youtube
│   └─ Channels → Channel → Videos → Video Performance
│        → Production (productionId) → Master (delivery asset / master hash) → Final Cut (report) → Cost (cost report)
│        Joined by ids, never duplicated: yt_video_links.project_id ↔ fc_master_metrics.production_id ↔ generation_costs.request_id
└─ System Health                  section=system-health (unavailable sources, stale jobs, provider states, AUTO_PUBLISH, Final Cut gate)
```

## Surfaces
Desktop web, mobile web and the installed PWA consume the same service; no business logic in components. Mobile-first layout; every section must degrade to a list on a phone. Charts only over KNOWN series (no fake curves).

## Not in V0
Visual dashboard, Stripe/revenue, provider router automation, learning from YouTube, native apps, offline production, service worker caching of any admin/API data.
