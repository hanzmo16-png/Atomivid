# Provider Capacity Monitor

Updated 2026-10-05. The current preventive operating plan is [PROVIDER_SUPPLY_CONTROLS.md](../PROVIDER_SUPPLY_CONTROLS.md). Its stricter admission controls supersede the older informational snapshot forecast.

The provider registry contains secret reference names, never values. Historical balances in old reports are not current capacity. The production paid-call store checks funded global/provider ceilings, verified supply, concurrent calls and daily limits atomically before setting SUBMITTED. Full media jobs reserve their supplier units and cash before admission; unused capacity may be released while submitted/uncertain consumption stays protected.

Supply monitoring reads ElevenLabs included characters, Runway API credits and a HeyGen prepaid API wallet when applicable. Other supplier balances stay UNKNOWN until certified. Alerts use 30% / 72-hour and 15% / 24-hour thresholds, account for reserved pending work and keep unsuccessful deliveries in a durable outbox.

Policies are OFF by default. Account verification, funded limits, real alarm delivery, infrastructure quotas and coordinated page/worker rollout are still launch requirements. Neither a pricing estimate nor a simulated 50-request test is a verified live balance or capacity guarantee.
