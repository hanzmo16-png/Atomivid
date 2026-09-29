# Pilot gate for PI V1.1 (documentation only; the worker is NOT connected)

This gate only applies if a single-project pilot is authorized later. Nothing here is wired.

1. **One project, pinned.**
   - The project is pinned to `policy/1.1.0-candidate`, `longform-16x9/1.1`, `shot-contract/1` (or 1.1), `rate-card/2026-09-28.1` and `mem_empty`.
   - Any version mismatch raises `SnapshotMismatchError` and nothing is paid.
2. **Valid `reservation_id` → paid call eligible.**
   - A paid provider call is eligible only if it carries a `reservation_id` of a RESERVED project reservation whose worst case covers the call (`assertWithinReservation`).
   - It also needs an idempotency key recorded in `pi_paid_operations` before submission (`executePaidOperation`).
3. **No `reservation_id` → hard reject.**
   - The call is refused before any network I/O.
   - There is no fallback to "spend anyway", and no retry without a key.
4. **Never two spenders on one project.**
   - The legacy planner and PI never spend on the same project in parallel.
   - A project is owned by exactly one planner for its whole life. The other can only run in SHADOW, with zero network calls, as `runShadow` enforces.
5. **Prerequisites before any paid pilot:**
   - 0023 applied with explicit authorization (ledger and pins tables);
   - a kill switch;
   - capacity checks where UNKNOWN is never treated as GREEN;
   - the C8 audit of unused paid assets gating the master.
6. **Distribution Intelligence stays frozen.** No YouTube OAuth, analytics, upload or tokens, and C12 holds: distribution data never enters `decide()`.
