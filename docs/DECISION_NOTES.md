# SLA Breach Tracking — Decision Notes

**Feature:** Part 2 — SLA computation, breach tracking, and filtering  
**Author:** Yadav Aman Singh  
**Date:** 11-09-2026  
**Assignment:** Bilions Full Stack Developer Internship Exercise  
**Codebase:** `meridian_helpdesk_starter`

---

## 1. SLA Targets & Calculation

| Priority | Target | Start Trigger | Deadline |
|:---:|:---:|---|---|
| **P1** | **4 hours** | `ticket.created_at` | `created_at + 4 hours` |
| **P2** | **24 hours** | `ticket.created_at` | `created_at + 24 hours` |
| **P3** | **72 hours** | `ticket.created_at` | `created_at + 72 hours` |

- **Decision:** The clock starts deterministically at `ticket.created_at` using existing targets in `config.slaTargets`.
- **Why:** The specification defines priority targets without introducing a separate "ticket opened" lifecycle event. `created_at` reflects the exact moment the customer requested help.

---

## 2. First-Response Semantics & Edge Cases

The brief specifies tracking whether *"we have not responded within the target"*. We treated this as a **First-Response SLA**, resolving several real-world edge cases:

1. **Who stops the clock?**
   - **Decision:** Only the first comment authored by a support user with `role IN ('agent', 'admin')` satisfies the SLA and records `firstRespondedAt`.
   - **Why:** If a customer posts a follow-up comment on their own ticket, they are still waiting for assistance. Requester comments must never stop the SLA clock.
2. **Closing a ticket without replying:**
   - **Decision:** Status transitions (including `closed`) do **not** stop the SLA clock.
   - **Why:** Closing or archiving a ticket without an actual agent response does not satisfy a customer service response SLA.
3. **Late responses do not erase breaches:**
   - **Decision:** If an agent responds after the deadline passes, the ticket remains permanently `BREACHED`. The response timestamp is still recorded in `firstRespondedAt`.
   - **Why:** SLA compliance represents historical reality. Allowing a late reply to reset the state to `MET` would mask operational violations.
4. **Exact boundary condition:**
   - **Decision:** A ticket is breached strictly when `now > deadline`. It is **not** breached at the exact boundary instant (`now === deadline`).
   - **Why:** "Within 4 hours" naturally includes the 4th hour mark. The deadline is the final valid moment inside the SLA window.

---

## 3. SLA Lifecycle States

Instead of a lossy boolean, each ticket is assigned one of three explicit states:

- **`WITHIN_SLA`**: Ticket has received no agent comment yet, but `now <= deadline` (active window).
- **`MET`**: First agent/admin response occurred on or before the deadline (`firstRespondedAt <= deadline`).
- **`BREACHED`**: Deadline has passed without a response, or the first response occurred after the deadline.

*(A convenience boolean `breached: true/false` is also returned to simplify frontend badge styling and filtering.)*

---

## 4. Scalable Database Filtering & Pagination

- **Decision:** SLA filtering (`?slaState=BREACHED`) and pagination counts (`COUNT(*)`) are evaluated directly in MySQL using SQL expressions, rather than filtering in JavaScript memory.
- **Why:** A naive approach of fetching all organization tickets (`SELECT *`) and running `tickets.filter().slice()` in Node.js creates severe $O(N)$ memory overhead and breaks database indexing as ticket volume grows.
- **Implementation:**
  - Constructed dynamic SQL expressions using `DATE_ADD`, `CASE`, and a correlated subquery for the earliest support response:
    ```sql
    (SELECT MIN(c.created_at)
       FROM comments c
       JOIN users u ON u.id = c.author_id
      WHERE c.ticket_id = t.id
        AND u.role IN ('agent', 'admin'))
    ```
  - Node.js only ever materializes the 20 records requested for the active page (`LIMIT 20 OFFSET ?`), keeping application memory consumption minimal and predictable regardless of table size.

---

## 5. API Design & Backward Compatibility

- **Decision:** No `/api/v1` or `/api/v2` version prefix was introduced.
- **Why:** The changes are purely additive:
  - `GET /api/tickets` and `GET /api/tickets/:id` include an additive `.sla` metadata object.
  - Filtering is exposed as opt-in query parameters: `GET /api/tickets?slaState=BREACHED` (and `?breached=true`).
  - Existing clients that ignore the `.sla` object continue functioning with zero breaking changes.

---

## 6. Defensive Defaults

- **Continuous 24/7 Clock:** SLA runs continuously without business-hour or weekend exclusions, adhering strictly to the brief without inventing unrequested calendar logic.
- **Timestamp Arithmetic:** Elapsed time is calculated consistently using standard timestamp arithmetic (`created_at + INTERVAL N HOUR`) across both MySQL and JavaScript `Date` instances.
- **Unknown Priority Guard:** If an unrecognized priority value is encountered, `computeSla` safely returns `state: 'UNKNOWN'` and `breached: false` rather than throwing an unhandled exception.
