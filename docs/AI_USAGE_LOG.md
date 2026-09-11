# AI Usage Log

**Author:** Yadav Aman Singh  
**Date:** 11-09-2026  
**Assignment:** Bilions Full Stack Developer Internship Exercise (Part 3)  
**Codebase:** `meridian_helpdesk_starter`

---

## 1. Assistants Used

- **ChatGPT (GPT-4o)** — Brainstorming partner for SLA edge-case logic, security sanity-checking, Git commit conventions, and documentation formatting assistance.
- **IDE Assistant (Gemini 3.8 flash)** — Local codebase navigation, syntax verification, and some implementation planning.

---

## 2. How AI Was Used

AI was used as an interactive **sounding board and editorial assistant**, not as an authoritative code generator:

- **SLA Edge-Case Brainstorming:** Exploring boundary conditions (first-response vs. resolution, customer vs. agent comments, late replies, and unresponded closures).
- **Security Reasoning:** Bouncing vulnerability hypotheses (IDOR, broken authorization, SQL injection allowlisting) against industry patterns.
- **Git Commit Standards:** Structuring atomic pull requests and Conventional Commit tags (`feat:`, `fix:`, `docs:`).
- **Documentation Structuring:** Assisting in formatting Markdown tables, proofreading descriptions, and organizing review notes for readability.

All architectural decisions, database queries, and code fixes were designed, verified, and written by me. AI suggestions were treated as hypotheses and audited against the schema and runtime behavior.

---

## 3. Key Tasks: What AI Suggested vs. What I Actually Implemented

### 1. SLA Filtering & Pagination (In-Memory vs. Database-Side)
- **What I asked:** How to implement `?slaState=BREACHED` with 20 items per page in Express/MySQL.
- **What AI suggested:** A naive in-memory approach: fetch all organization tickets into Node (`SELECT *`), loop through them in JavaScript to calculate SLA, filter with `.filter()`, and paginate with `.slice()`.
- **Why I rejected it:** In-memory slicing fails at scale. Fetching 50,000 records into Node.js memory consumes massive RAM, defeats database indexing, and breaks pagination counts.
- **What I built:** Rejected the AI code and implemented the filtering directly in MySQL using `DATE_ADD`, `CASE`, and a correlated subquery for the earliest support response (`MIN(c.created_at)` from `agent`/`admin`), ensuring Node.js only ever materializes the 20 records on the active page.

### 2. SQL Injection in `ORDER BY` (Hallucinated Exploit vs. Strict Allowlist)
- **What I asked:** How `ORDER BY t.${sortBy} ${order}` can be exploited and remediated.
- **What AI suggested:** Claimed that an attacker could inject an inline `UNION SELECT` directly into `sortBy` to dump the `users` table, and suggested parameterizing it with `?`.
- **Why I caught it:** MySQL grammar does not allow a raw `UNION SELECT` inside an `ORDER BY` clause, and SQL drivers cannot parameterize column identifiers or keywords (`ASC`/`DESC`) with `?`.
- **What I built:** Documented the finding accurately as dynamic query manipulation without unsupported exploit claims, and resolved it using strict server-side allowlists (`ALLOWED_SORT` and `ALLOWED_ORDER`).

### 3. SLA Clock-Stopping Rules & Edge Cases
- **What I asked:** What edge cases should be considered for a First-Response SLA.
- **What AI suggested:** Suggested stopping the SLA clock on *any* comment added to the ticket, or whenever `ticket.status === 'closed'`.
- **Why I corrected it:** If a customer comments on their own ticket, they haven't received help yet. Likewise, closing a ticket without replying does not satisfy a First-Response SLA.
- **What I built:** Designed the clock-stopping trigger strictly around the first comment authored by an `agent` or `admin`. Requester comments, status changes, and unresponded closures do not stop the breach clock.

---

## 4. Summary of Caught Flaws

| Topic | What AI Suggested | Why It Was Misleading / Flawed | What I Implemented Instead |
|---|---|---|---|
| **Pagination** | In-memory `SELECT *` + `.filter().slice()` | $O(N)$ memory overhead; bypasses DB indexes | Database-side SQL expressions and correlated subqueries |
| **SQL Injection** | `UNION SELECT` dump via `ORDER BY` | Invalid MySQL syntax; drivers cannot bind identifiers | Accurately documented risk; implemented strict allowlist |
| **SLA Clock** | Any comment or closure stops clock | Customers commenting on own ticket or unresponded closure != response | Clock stops strictly on first `agent`/`admin` comment |
| **Boundary** | `now >= deadline` | 4 hours includes the boundary instant | Strict greater-than: `now > deadline` |

---

## 5. Verification

Every suggestion and fix was validated through direct hands-on testing:
1. Traced request flows through `routes` → `services` → `MySQL`.
2. Tested multi-tenant boundary checks with seeded users (Northwind vs. Cobalt).
3. Verified boundary logic against seed tickets at exact target timestamps.
