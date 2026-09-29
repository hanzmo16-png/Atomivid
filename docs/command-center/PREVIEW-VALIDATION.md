# Command Center — Preview validation against the real database (2026-09-29)

Scope: make the Vercel PREVIEW of Command Center Visual V1 work against the already-migrated real
database, without touching Production (`dpl_2M9CMeePkrhV2UHPBHhYNGf9ZX3j`, commit `11faaa8`).

## What was observed

- Every preview of this branch is behind **Vercel Deployment Protection**: an anonymous request to any
  route answers `302 → https://vercel.com/sso-api?...` (probe runs 36628478132 and 36628527760 on
  `atomivid-4ukc4r8f2` = commit `0a61a18` and `atomivid-e9lyovtyr` = commit `2a4a62d`). The app
  never runs for an unauthenticated probe, so the HTTP 500 the operator saw came from the app
  after passing the Vercel SSO gate.
- The Command Center page lives at **`/dashboard/command-center`** (API `/api/admin/command-center`).
  There is no `/admin/command-center` route; that path answers the app's 404.
- Local production build of HEAD (`next build && next start`):
  - complete Supabase configuration → `/` 200, `/login` 200, `/manifest.webmanifest` 200,
    `/dashboard/*` 307 → `/login`, `/api/admin/command-center` 401. No 5xx.
  - `NEXT_PUBLIC_SUPABASE_URL` missing → **every route (including `/`) answered a bare
    `500 Internal Server Error`**, thrown by the proxy/middleware (`updateSession` →
    `getSupabaseUrl()` → `MissingEnvVarError`) before any page or route function runs. This is
    the only code path found that produces a 500 on all routes with no function-level log.

## Root cause (exact)

The proxy (`src/proxy.ts`, Next 16 middleware) reads `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` on every request. If either is missing or empty in the
environment of the deployment (Preview scope in Vercel), the thrown `MissingEnvVarError` became
an opaque 500 on every path, and because it happens at the edge before the page function, the
Functions runtime logs show nothing for the page. Production works because its scope has the
variables.

The code change (`src/proxy.ts`) does not alter behaviour with a complete configuration; it turns
the opaque 500 into a logged **503** with header `x-atomivid-config-error: <VARIABLE NAME>` and a
plain-text body naming the variable (name only, never a value). Verified in a local production
build (503 + header on all routes with the variable missing; identical 200/307/401 behaviour with it
present) and by `src/proxy.test.ts`.

## What the operator must check in Vercel (Preview scope) for the Command Center to load

| Variable | Needed by | Without it |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | proxy, every page | 503 on every route (was 500) |
| `SUPABASE_SERVICE_ROLE_KEY` | Command Center page and API | 500 on `/dashboard/command-center` and `/api/admin/command-center` (function log shows `MissingEnvVarError`) |
| `AVATAR_PREPARATION_OWNER_EMAIL` (or `COMMAND_CENTER_ADMIN_EMAILS`) | admin gate | page 404 / API 403 for everyone |
| `GOOGLE_OAUTH_*`, `YOUTUBE_TOKEN_ENC_KEY` | not required | YouTube shows NOT CONFIGURED (honest state) |

Vercel → Project `atomivid` → Settings → Environment Variables → each variable must have the
**Preview** environment enabled (or be scoped to the branch), then redeploy the preview.

## Probing a protected preview from CI

`.github/workflows/preview-smoke.yml` (dispatch input `base_url`) prints status, Vercel error
code, headers and the body head per route, and refuses the production alias. To get past
Deployment Protection, create a "Protection Bypass for Automation" secret in Vercel and store it as
the GitHub secret `VERCEL_AUTOMATION_BYPASS_SECRET`; the workflow then sends
`x-vercel-protection-bypass`. Without it the probe only proves the SSO redirect.

## Confirmations

No migration was applied or re-run (0023–0030 are already applied in production; the runner's
registry still lists only 0001–0022 because those migrations were applied outside the runner, see
`docs/security/DB-HARDENING-V1.md`). `AUTO_EXECUTE = false`. `AUTO_PUBLISH` is the literal `false`.
No OAuth, no YouTube connection, no paid API, no video generated, Production untouched.
