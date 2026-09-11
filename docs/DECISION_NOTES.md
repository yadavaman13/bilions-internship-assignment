# SLA Breach Tracking — Decision Notes

**Feature:** Part 2 - SLA computation and breach filtering  
**Author:** Yadav Aman Singh  
**Date:** 11-09-2026

---

## SLA Calculation

**Decision:** The SLA deadline is calculated as `ticket.created_at + priority target`.

| Priority | Target |
|----------|--------|
| P1 | 4 hours |
| P2 | 24 hours |
| P3 | 72 hours |

Targets are read from the existing `config.slaTargets` object. No new configuration was introduced.

**Reason:** The specification provides priority-based targets but does not define a separate SLA start event. `created_at` is the most deterministic starting point and reflects when the customer first needed help.

---

## SLA Type

**Decision:** First-response SLA. The clock stops at the first comment authored by a user with `role IN ('agent', 'admin')`.

Customer comments, status changes, and ticket closure do not stop the clock. Closing a ticket without a support response does not satisfy the SLA.

**Reason:** The specification says *"if we have not responded within the target"* — this is response-specific language. Using comment author role to identify a support response was the only reliable signal in the existing schema without a schema change.

---

## Breach Boundary

**Decision:** A ticket is breached when `now > deadline` (strict greater-than). A ticket is **not** breached at the exact deadline instant.

**Reason:** "Within 4 hours" naturally includes the boundary. The deadline is the last moment inside the SLA window, not the first moment of breach. This is the more common interpretation in production SLA systems.

---

## Three States, Not a Boolean

**Decision:** SLA state is one of: `WITHIN_SLA`, `MET`, `BREACHED`.

A `breached: boolean` field is also returned for easy client-side filtering.

**Reason:** A boolean alone cannot distinguish between a ticket that is actively within its window (`WITHIN_SLA`) and one that was answered on time (`MET`). The three-state model preserves historical information for reporting.

---

## Late Response Does Not Erase Breach

**Decision:** If a support agent responds after the deadline, the ticket state is permanently `BREACHED`. The response timestamp is still recorded in `firstRespondedAt`.

**Reason:** SLA breach reflects what happened historically. Allowing a late response to reset the state would give support teams a way to hide violations, defeating the purpose of SLA reporting.

---

## No DB Persistence

**Decision:** SLA state is computed at query time from `created_at`, `priority`, the first agent/admin comment timestamp, and the current server time. Nothing new is stored in the database.

**Reason:** A persisted `sla_breached` boolean would go stale the moment a deadline passes without a write operation. Deriving it at read time is always accurate and requires no migration.

---

## Weekends and Holidays

**Decision:** SLA runs continuously — no business-hours calendar, no weekend exclusions, no holiday rules.

**Reason:** The specification states only `P1: 4h, P2: 24h, P3: 72h` with no mention of business hours. Adding a calendar would be inventing a requirement not present in the brief.

---

## Timezones

**Decision:** All comparisons use JavaScript `Date` objects constructed from MySQL `DATETIME` values, which the driver returns as UTC-aligned. No manual timezone conversion was introduced.

**Reason:** SLA is elapsed time (`created_at + N hours`). Absolute UTC timestamps make the arithmetic correct regardless of the user's locale.

---

## Unknown Priority

**Decision:** If a ticket has a priority value not in `config.slaTargets`, `computeSla` returns `state: 'UNKNOWN'` and `breached: false` rather than throwing. The ticket is excluded from the `slaBreached=true` filter.

**Reason:** The `tickets.priority` column is an `ENUM('P1','P2','P3')` — this case cannot occur with the current schema. The guard exists purely as a defensive measure against future schema drift.

---

## API Versioning

**Decision:** No `/api/v1` prefix was introduced. The existing endpoints were extended:

- `GET /api/tickets` — each ticket now includes a `.sla` object
- `GET /api/tickets/:id` — ticket now includes a `.sla` object  
- `GET /api/tickets?slaState=BREACHED` — filter to breached tickets only
- `GET /api/tickets?slaState=MET` — filter to tickets met within SLA
- `GET /api/tickets?slaState=WITHIN_SLA` — filter to tickets still within window

**Reason:** The changes are additive. Existing consumers that ignore the `.sla` field are unaffected. The new `slaState` filter parameter is opt-in. No breaking change warrants a version bump.

---

## Database-Level SLA Filtering & Scalability

**Decision:** All SLA filtering, counting, and pagination are executed directly in MySQL via SQL expressions rather than fetching all rows and filtering in application memory.

```sql
-- Correlated subquery for earliest support response:
(SELECT MIN(c.created_at)
   FROM comments c
   JOIN users u ON u.id = c.author_id
  WHERE c.ticket_id = t.id
    AND u.role IN ('agent', 'admin'))

-- Deadline expression based on priority targets:
DATE_ADD(t.created_at, INTERVAL (CASE t.priority WHEN 'P1' THEN 4 WHEN 'P2' THEN 24 WHEN 'P3' THEN 72 ELSE 72 END) HOUR)
```

1. **SQL-Level Filtering**: When `slaState` (`BREACHED`, `MET`, `WITHIN_SLA`) is specified, the state condition is added directly to the SQL `WHERE` clause.
2. **Database Counting**: `SELECT COUNT(*) AS total FROM tickets t WHERE ${whereSql}` accurately computes pagination totals inside MySQL without transferring rows over the wire.
3. **True SQL Pagination**: `LIMIT 20 OFFSET ?` ensures only the current page of 20 tickets is returned.
4. **Targeted Enrichment**: `enrichWithSla(rows)` executes a single batched first-response query (`ticket_id IN (...)`) for **at most 20 IDs** to compute full rich SLA metadata.
5. **O(1) Memory**: Memory consumption in the Node.js process remains constant $O(1)$ regardless of whether the organisation has 100 tickets or 1,000,000 tickets.

**Indexing Recommendations for Production Scale:**
- `tickets(org_id, created_at)`: for fast org-scoped filtering and default sorting.
- `comments(ticket_id, created_at, author_id)`: composite index covering the earliest response subquery.
- `users(id, role)`: index on user roles so role lookups in comment joins are fast.

