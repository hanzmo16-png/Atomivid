# Provider Capacity Monitor

**What.** `src/lib/production-intelligence/capacity/`: snapshots per provider, status GREEN / YELLOW / RED / UNKNOWN, admission control, a simple forecast, and a non-secret account registry.

**Why.** During DULCE, ElevenLabs ran out of characters and OpenAI returned `insufficient_quota` mid-production; a workspace mix-up also confused which account was paying.

## Model
`free = available − reserved` (balance is not free capacity). GREEN: reserved + pending + 15% buffer covered. YELLOW: committed work covered, new work risky (or provider degraded). RED: reserved work not covered, or provider down. UNKNOWN: no verifiable balance.
Admission: a new project is covered only if `free ≥ requirement + buffer`. UNKNOWN is **not** covered unless an operator explicitly accepts it; it is never promoted to GREEN (also enforced by a DB constraint in migration 0023).
Forecast: mean daily use over 14 days → depletion date vs renewal date. No ML.

## Providers
| Provider | Source | Status today |
|---|---|---|
| ElevenLabs | `GET /v1/user/subscription` (official, read-only) | Real balance (last run: 26,518 of 63,002 characters). Renewal from `next_character_count_reset_unix` |
| OpenAI | No official API-credit balance endpoint. Key health via free `GET /v1/models` | **UNKNOWN**; informative estimate = registered top-ups − ledger consumption (e.g. 10 − 3.79 = 6.21) |
| Runway | No verified balance endpoint (docs not reachable from the build environment; nothing in the repo) | **UNKNOWN**; tier-1 limits noted in the registry |

## Registry
`accounts.ts` (and table `pi_provider_accounts`) stores provider, production account label, plan, **secret reference name** (e.g. `OPENAI_API_KEY`), renewal, status, notes. Never key values; a DB check rejects anything that is not an env-style name.

## How to test
Tests 13–15 and 18 in `production-intelligence.test.ts` (fetch is injected; no network).

## Not implemented yet
Scheduled capacity checks and persistence (table `pi_capacity_snapshots` exists, not applied); Runway balance until an official endpoint is verified; admission wired into project confirmation.
