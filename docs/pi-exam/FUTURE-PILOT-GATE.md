# Future single-project pilot gate (documented, NOT implemented)

Only after an exam PASS and explicit authorization.

1. **reservation_id is mandatory**: every paid call made by the worker must carry a valid `reservation_id` (an open `pi_paid_operations` row in RESERVED/SUBMITTED for that project). The worker rejects the call physically (it cannot build the provider request without it); a ledger written by PI alone is not enough.
2. **No reservation_id → no paid call.** A missing or closed reservation fails before any network I/O.
3. **One planner per project**: a pilot project is flagged `planner = pi`; the legacy planner refuses to spend on it, and PI refuses to spend on any project not flagged. Never both planners spending in parallel.
4. Approved quote → worst-case budget reserved (`reserveProject`) → project pin frozen → human review at still and clip QA → hard kill switch (`assertWithinReservation`) before every call → settlement releases the unused reservation.
5. Rollback: turning the flag off returns the project to manual review; nothing is deleted.
