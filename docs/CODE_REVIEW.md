# Meridian Helpdesk — Code Review

**Reviewer:** Yadav Aman Singh  
**Date:** 11-09-2026  
**Codebase:** `meridian_helpdesk_starter` — Node/Express + React/Vite/Redux

---

## Executive Summary

This codebase was written quickly and merged without review. It functions at a demo level but contains two critical security vulnerabilities, three high-severity authorization holes, and several functional and hygiene issues. The findings below are ranked by real-world business impact, not lines of code changed. Five fixes were applied; the remaining issues are documented with reasoning in Section 3.

---

## Section 1 — All Issues Found

### Full Ranked Table

| Rank | ID | Severity | Area | Title | Fixed |
|------|-----|----------|------|-------|-------|
| 1 | BUG-01+02 | **Critical** | Authentication | Unauthenticated password overwrite enables account takeover; invited user password stored as plaintext | ✅ Yes |
| 2 | BUG-03 | **Critical** | Injection | `sortBy` / `order` query params interpolated directly into SQL — unsanitised user input in `ORDER BY` | ✅ Yes |
| 3 | BUG-04 | **High** | Data Isolation | IDOR — `GET /tickets/:id` returns tickets from any organisation | ✅ Yes |
| 4 | BUG-05 | **High** | Authorization | `DELETE /tickets/:id` missing `requireRole('admin')` and org check | ✅ Yes |
| 5 | BUG-07 | **High** | Authorization | `PATCH /tickets/:id/assign` — no role guard; any requester can claim tickets cross-tenant | ✅ Yes |
| 6 | BUG-06 | **High** | Security | Stored XSS — `dangerouslySetInnerHTML` on untrusted comment body | ❌ No |
| 7 | BUG-08 | **Medium** | Functional | Pagination offset off-by-one — page 1 always skips the first 20 rows | ❌ No |
| 8 | BUG-09 | **Medium** | Functional | `TicketList` `useEffect` dep array is `[page]` only — filter/sort controls never trigger a re-fetch | ❌ No |
| 9 | BUG-15 | **Medium** | Security Hygiene | JWT secret falls back to hard-coded `'dev-secret-change-me'` when env var is absent | ❌ No |
| 10 | BUG-11 | **Medium** | Security Hygiene | `server/.env` not listed in `.gitignore` — credentials would be committed to version control | ❌ No |
| 11 | BUG-12 | **Low** | Security Hygiene | Wildcard CORS with no origin restriction (`app.use(cors())`) | ❌ No |
| 12 | BUG-13 | **Low** | Performance | N+1 query — comment count fetched per-ticket in a loop | ❌ No |
| 13 | BUG-14 | **Low** | Dev Artifact | Login form pre-fills credentials (`agent1@northwind.test / Password123!`) | ❌ No |

> **Note on BUG-10 (Claim button shown to all roles):** This UI symptom is a direct consequence of BUG-07 and is not listed as a separate finding. Before BUG-07 was fixed server-side, the button exposed a real unauthorized capability. After BUG-07 is fixed, the button becomes a defense-in-depth UI consistency issue. It is addressed by the BUG-07 fix — no separate entry is done.

> **Note on BUG-11:** The `.gitignore` was updated as repository hygiene before submission. This is not counted as one of the five Part 1 application fixes. The finding is documented to record that it was observed.

---

### Detailed Descriptions

---

#### BUG-01+02 · Critical · `/invite/accept` — unauthenticated password overwrite + plaintext storage
**Location:** `server/src/routes/auth.js:42–54`

The endpoint accepts `{ userId, password }` with no authentication, then writes the raw password string directly into the `password_hash` column:

```js
await query('UPDATE users SET password_hash = ? WHERE id = ?', [password, userId]);
```

Two failures compound here:

1. **Security failure:** There is no token, challenge, or session requirement. Any unauthenticated caller who supplies a valid sequential integer `userId` can overwrite that account's password. User IDs start at 1 and increment — they are guessable. This is an unauthenticated password overwrite that enables full account takeover.

2. **Functional failure:** The login flow calls `bcrypt.compare(password, user.password_hash)`. Because the stored value is raw plaintext, not a bcrypt hash, `compare` will always return false. Every user who completes the invite flow is permanently locked out of their own account.

Both failures are in the same 12-line function and are fixed atomically.

---

#### BUG-03 · Critical · Unsanitised user input in SQL `ORDER BY`
**Location:** `server/src/services/ticketService.js:38`

Both `sortBy` and `order` are interpolated directly into the SQL statement using template literals:

```js
ORDER BY t.${sortBy} ${order}
```

These values originate from `req.query` with no restriction. Because they are placed inside the SQL string before the driver can parameterise them, an attacker controls the shape of the generated query. Injecting unexpected SQL keywords or expressions into an `ORDER BY` clause can alter query behavior — for example, forcing conditional evaluation or influencing result ordering based on data from other rows or tables. The precise exploitability depends on the MySQL version and driver configuration and was not fully tested; the claim made here is that **unsanitised user input reaches the SQL string**, which is the definitive vulnerability regardless of exact exploit path.

---

#### BUG-04 · High · IDOR on `GET /tickets/:id`
**Location:** `server/src/routes/tickets.js:31–41` · `server/src/services/ticketService.js:57–67`

`getTicketById` queries by primary key only — no `org_id` filter. The route does not compare the returned ticket's `org_id` to `req.user.orgId`. A Cobalt user can read any Northwind ticket by guessing sequential IDs, violating the tenant-isolation requirement stated in the README.

---

#### BUG-05 · High · `DELETE /tickets/:id` — missing role guard and org check
**Location:** `server/src/routes/tickets.js:75–84`

The route is documented as "Admin only" but is guarded only by `requireAuth`. Any authenticated user — including `requester` — can delete any ticket. No org check means a Cobalt requester can delete Northwind tickets.

---

#### BUG-07 · High · `PATCH /tickets/:id/assign` — no role guard, no org check
**Location:** `server/src/routes/tickets.js:62–73`

Any authenticated user including `requester` can call `PATCH /tickets/:id/assign`. There is no `requireRole` guard and no `org_id` comparison. A Cobalt requester can claim a Northwind ticket, which is a cross-tenant unauthorized write — not merely a UI inconsistency.

The UI symptom (the Claim button appearing for requesters) is a direct consequence of this server-side gap and is not listed as a separate finding.

---

#### BUG-06 · High · Stored XSS in comment renderer
**Location:** `client/src/features/tickets/TicketDetail.jsx:65`

```jsx
<div dangerouslySetInnerHTML={{ __html: c.body }} />
```

Comment bodies are submitted as plain text from a `<textarea>`. There is no rich-text editor, no markdown pipeline, and no use case for HTML rendering. An attacker with comment-posting rights (any authenticated user) can store a script payload that executes in every subsequent viewer's browser — including admins.

This is ranked below BUG-07 because it requires an authenticated attacker who already has comment-posting access. BUG-07 is exploitable by any authenticated user with no additional prerequisites and produces a cross-tenant write.

---

#### BUG-08 · Medium · Pagination offset off-by-one
**Location:** `server/src/services/ticketService.js:29`

```js
const offset = page * PAGE_SIZE;   // page=1 → offset 20
```

Should be `(page - 1) * PAGE_SIZE`. With the current code, page 1 skips the first 20 rows entirely and shows rows 21–40. The first page of data is unreachable. This is visible to every user on first load.

---

#### BUG-09 · Medium · TicketList filter controls have no effect
**Location:** `client/src/features/tickets/TicketList.jsx:31`

```js
useEffect(() => { ... }, [page]);   // search, status, priority, sortBy absent from deps
```

Filter state (`search`, `status`, `priority`, `sortBy`) is included in the URL query string but the `useEffect` only re-runs when `page` changes. Changing any filter has no effect on the data displayed.

---

#### BUG-15 · Medium · Hard-coded JWT secret fallback
**Location:** `server/src/config.js:16`

```js
jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
```

When `JWT_SECRET` is absent from the environment, the application silently uses a publicly known string to sign JWTs. An attacker who knows this fallback can forge valid tokens for any user ID and role without credentials. The presence of a real secret in the current `.env` does not eliminate the defect — any deployment where the variable is accidentally omitted becomes fully compromised. The correct fix is to fail startup when the secret is absent rather than silently falling back.

---

#### BUG-11 · Medium · `server/.env` not gitignored
**Location:** root `.gitignore`

The root `.gitignore` excludes only `node_modules/`, `dist/`, and `*.log`. `server/.env` (which contains the database password and JWT secret) is not listed. In a shared or public repository this would commit live credentials. The `.gitignore` was updated as repository hygiene before submission; this is documented as a finding but is not counted as one of the five Part 1 application fixes.

---

#### BUG-12 · Low · Wildcard CORS
**Location:** `server/src/index.js:9`

`app.use(cors())` with no `origin` option allows requests from any domain.

---

#### BUG-13 · Low · N+1 comment count query
**Location:** `server/src/services/ticketService.js:44–47`

A `SELECT COUNT(*)` is issued per-ticket in a loop. For a page of 20 tickets this is 21 queries per list request. Should be a single `GROUP BY` subquery joined to the main result.

---

#### BUG-14 · Low · Login form pre-fills credentials
**Location:** `client/src/features/auth/Login.jsx:10–11`

`useState('agent1@northwind.test')` and `useState('Password123!')` — development convenience left in the codebase.

---

---

## Section 2 — Fixes Applied

Five fixes were applied on individual branches under `review/part-1`, each as a separate commit.

---

### Fix 1 — Secure `/invite/accept`: verify token and hash password

**Branch:** `fix/part-001-invite-accept-hash-and-auth`  
**Commit:** `fix: verify invite token and bcrypt-hash password in /invite/accept`

**What was wrong:** The endpoint stored the raw password string instead of a bcrypt hash, and required no authentication — any caller with a valid `userId` integer could overwrite any account's password.

**Fix applied:**
- Replaced the `userId` request body field with a signed JWT `token` (carrying `sub = userId`), verified using the existing `config.jwtSecret`. No DB schema changes needed.
- Added `bcrypt.hash(password, 12)` before the `UPDATE` — stores a proper hash.
- Added minimum password length check (≥ 8 characters).
- The `userId` is now extracted from the verified token, not trusted from the request body.

---

### Fix 2 — Allowlist `sortBy` and `order` to eliminate SQL injection risk

**Branch:** `fix/part-002-sql-injection-sort-allowlist`  
**Commit:** `fix: allowlist sortBy and order params to prevent SQL injection`

**What was wrong:** Both query parameters were interpolated directly into the SQL `ORDER BY` clause with no sanitisation.

**Fix applied:**
- Added two `Set` constants — `ALLOWED_SORT` and `ALLOWED_ORDER` — at the top of `ticketService.js`.
- Both parameters are checked against their allowlist before use; any unrecognised value falls back to a safe default (`created_at`, `desc`).
- No route or schema changes required.

---

### Fix 3 — Add org check to `GET /tickets/:id` (IDOR)

**Branch:** `fix/part-003-idor-ticket-detail-org-check`  
**Commit:** `fix: enforce org_id check on GET /tickets/:id to prevent IDOR`

**What was wrong:** Any authenticated user could fetch any ticket by ID regardless of organisation.

**Fix applied:**
- Added `if (ticket.org_id !== req.user.orgId) return res.status(404).json({ error: 'Not found' })` immediately after the null check in the route handler.
- Returns 404, not 403: confirming that a resource exists at a different org is itself an information disclosure.
- The org check is placed in the route (the existing authorization boundary in this codebase) rather than the service layer, keeping the change minimal and consistent. In a larger refactor, centralizing tenant authorization in the service/data layer would give stronger guarantees to all callers.

---

### Fix 4 — Add `requireRole('admin')` and org check to `DELETE /tickets/:id`

**Branch:** `fix/part-004-delete-auth-role-and-org`  
**Commit:** `fix: add requireRole(admin) and org check to DELETE /tickets/:id`

**What was wrong:** Any authenticated user (including `requester`) could delete any ticket in any organisation. The README documents this as "Admin only" but the guard was never implemented.

**Fix applied:**
- Added `requireRole('admin')` as the second middleware argument, using the existing helper already imported in the file.
- Added `if (ticket.org_id !== req.user.orgId) return res.status(404)` before the delete call.

---

### Fix 5 — Add role guard and org check to `PATCH /tickets/:id/assign`

**Branch:** `fix/part-005-assign-role-and-org`  
**Commit:** `fix: add requireRole(agent,admin) and org check to PATCH /assign`

**What was wrong:** Any authenticated user including `requester` could self-assign any ticket from any organisation. No role guard and no org check.

**Fix applied:**
- Added `requireRole('agent', 'admin')` as the second middleware argument, using the existing helper.
- Added `if (ticket.org_id !== req.user.orgId) return res.status(404)` before the assign call — consistent with the org-isolation pattern applied in Fixes 3 and 4.

---

---

## Section 3 — What Was Not Fixed (and Why)

Five fixes only, per the assignment constraint. Each remaining issue is genuine and would be addressed in production.

| ID | Finding | Reason not fixed |
|----|---------|-----------------|
| BUG-06 | Stored XSS via `dangerouslySetInnerHTML` | Requires an authenticated attacker with comment-posting rights; all five fix slots were used for issues exploitable by any authenticated user or unauthenticated attacker |
| BUG-08 | Pagination offset off-by-one | Functional bug, no security impact; one-line fix that would be trivial to include but was deprioritised against the authorization issues |
| BUG-09 | TicketList filter `useEffect` deps | No security impact. **Not counted as a Part 1 fix** — any change to this file will be scoped strictly to the Part 2 SLA filter implementation only if required |
| BUG-15 | Weak JWT secret fallback | Not fixed as a Part 1 change; the correct fix (fail-fast on missing secret) is a startup behaviour change that warrants its own careful review |
| BUG-11 | `.env` not gitignored | Updated as repository hygiene before submission, not counted as one of the five application fixes |
| BUG-12 | Wildcard CORS | Low risk for this internal application at this stage |
| BUG-13 | N+1 comment count query | Performance concern only; no correctness or security impact |
| BUG-14 | Login pre-fills credentials | Dev convenience artifact; minor |
