# Ledger integration fixture

`0023-production-intelligence.sql` is an exact copy of
`supabase/migrations/0023_production_intelligence.sql` at historical commit
`9dccd68` of `hanzmo16-png/Atomivid`.

Source: https://github.com/hanzmo16-png/Atomivid/blob/9dccd68/supabase/migrations/0023_production_intelligence.sql

SHA-256: `0b49d9a4752d19c1b6f6f24df6c3f0c6fbdbd39136a41832f5a6189aa7fa8131`.

The test verifies these bytes before executing them. This fixture restores the
missing historical base **only inside a uniquely named disposable localhost test
database**. It does not restore a production migration or certify that every
application migration can be replayed from scratch. Provider balances and parent
application tables in this test are synthetic. Financial tables, triggers and
supply functions are loaded from this source and unchanged repository migrations.
