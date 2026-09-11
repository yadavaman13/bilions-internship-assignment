# Meridian Helpdesk — Code Review & Vulnerability Fixes

**Reviewer:** Yadav Aman Singh  
**Date:** 11-09-2026  
**Assignment:** Bilions Full Stack Developer Internship Exercise (Part 1)  
**Codebase:** `meridian_helpdesk_starter` — Node/Express + React/Vite/Redux + MySQL 8

---

## Executive Summary

A comprehensive security, authorization, and code quality review was conducted on the `meridian_helpdesk_starter` repository. The codebase functions at a basic demonstration level but contains significant architectural and security vulnerabilities resulting from rapid prototyping without peer review. 

The audit identified **two critical security vulnerabilities**, **three high-severity authorization and tenant-isolation flaws**, **one additional high-severity stored-XSS defect**, and several medium-to-low functional and hygiene issues. 

As Per the assignment specification, findings are prioritized strictly by **real-world business risk and tenant-isolation impact**, rather than lines of code. Exactly **five targeted, minimal fixes** were implemented on isolated Git branches and merged via atomic pull requests. The remaining issues are fully analyzed and documented with technical deferral rationale in Section 3.

---

## Section 1 — All Issues Found

### Full Ranked Table

| Rank | ID | Severity | Category | Title | Fixed |
|:---:|:---|:---:|:---|:---|:---:|
| **1** | BUG-01+02 | **Critical** | Authentication | Unauthenticated password overwrite enables account takeover; password stored as plaintext | ✅ Yes |
| **2** | BUG-03 | **Critical** | Injection | Dynamic string interpolation of untrusted `sortBy` / `order` into SQL `ORDER BY` clause | ✅ Yes |
| **3** | BUG-04 | **High** | Data Isolation | IDOR on `GET /tickets/:id` — missing tenant check leaks tickets cross-organization | ✅ Yes |
| **4** | BUG-05 | **High** | Authorization | `DELETE /tickets/:id` missing `requireRole('admin')` and organization verification | ✅ Yes |
| **5** | BUG-07 | **High** | Authorization | `PATCH /tickets/:id/assign` lacks role and tenant checks; requesters can claim cross-tenant | ✅ Yes |
| **6** | BUG-06 | **High** | Security | Stored XSS in comment renderer via `dangerouslySetInnerHTML` | ❌ Deferred |
| **7** | BUG-08 | **Medium** | Functional | Pagination offset calculation off-by-one (`page * PAGE_SIZE`); page 1 skips first 20 records | ❌ Deferred |
| **8** | BUG-09 | **Medium** | Functional | `TicketList` `useEffect` dependency array misses filter/sort state; controls fail to re-fetch | ❌ Deferred |
| **9** | BUG-15 | **Medium** | Security Hygiene | Hard-coded fallback JWT secret (`dev-secret-change-me`) silently used if env var is missing | ❌ Deferred |
| **10** | BUG-11 | **Medium** | Security Hygiene | `server/.env` omitted from root `.gitignore`; risk of credential leakage in source control | ❌ Deferred* |
| **11** | BUG-12 | **Low** | Security Hygiene | Permissive wildcard CORS (`app.use(cors())`) without origin restriction | ❌ Deferred |
| **12** | BUG-13 | **Low** | Performance | N+1 database query — comment count executed inside loop per ticket | ❌ Deferred |
| **13** | BUG-14 | **Low** | Dev Artifact | Hardcoded development credentials pre-filled in login form state | ❌ Deferred |

> **Consolidation Note on BUG-10 (Claim button shown to all roles):**  
> In the frontend, requesters can see the "Claim" button on ticket details. This is a direct UI symptom of the underlying server-side vulnerability (**BUG-07**). Because addressing BUG-07 server-side eliminates the unauthorized capability, BUG-10 is treated as a defense-in-depth UI consistency symptom of BUG-07 rather than a duplicate finding, conforming to the assignment brief.
>
> *\* **Repository Hygiene Note on BUG-11:**  
> The root `.gitignore` was updated as baseline repository hygiene prior to submission. In strict accordance with the rules, it is not counted as one of the five Part 1 application code fixes.

---

### Detailed Descriptions & Risk Analysis

---

#### BUG-01+02 · Critical · Unauthenticated Password Overwrite & Plaintext Storage
- **Location:** `server/src/routes/auth.js:42–54`
- **Impact:** Full Account Takeover & Permanent User Lockout
- **Affected Endpoint:** `POST /api/auth/invite/accept`

```javascript
// Vulnerable Code:
await query('UPDATE users SET password_hash = ? WHERE id = ?', [password, userId]);
```

Two severe defects compound in this single handler:
1. **Critical Security Failure (Account Takeover):** The endpoint accepts `{ userId, password }` from the request body with no authentication, session token, or cryptographic signature. Because user IDs are sequential auto-incrementing integers starting at 1, any unauthenticated attacker can submit a loop of `POST` requests and overwrite passwords for every account in the system (including administrators).
2. **Immediate Functional Failure (Authentication Denial of Service):** The handler writes the raw `password` string directly into the `password_hash` database column. The login route calls `bcrypt.compare(password, user.password_hash)`. Because `bcrypt.compare` expects a modular crypt formatted hash, it consistently returns `false` against plaintext strings. Every legitimate user who attempts to complete the invite flow is permanently locked out of their account.

---

#### BUG-03 · Critical · Unsanitized User Input in SQL `ORDER BY`
- **Location:** `server/src/services/ticketService.js:38`
- **Impact:** Dynamic Query Manipulation, Blind Inference, & Database Disruption
- **Affected Endpoint:** `GET /api/tickets?sortBy=...&order=...`

```javascript
// Vulnerable Code:
ORDER BY t.${sortBy} ${order}
```

The `sortBy` and `order` values originate directly from `req.query` and are interpolated into the SQL string via template literals without validation or sanitization:
- **Technical Risk Assessment:** SQL drivers (including `mysql2`) parameterize data literals with `?` placeholders, but do **not** support parameterization of SQL identifiers, column names, or syntax keywords (`ASC`/`DESC`). Because the user controls the query structure before execution, an attacker can supply malicious tokens.
- **Exploitation Reality:** While an inline `UNION SELECT` cannot be concatenated into an `ORDER BY` clause without causing a MySQL syntax error (a common AI misconception), untrusted interpolation inside `ORDER BY` enables boolean-based blind evaluation (e.g., `(CASE WHEN (condition) THEN id ELSE title END)`), error-based information leakage, or query execution disruption. Attacker-controlled input reaching executable SQL syntax represents a critical injection vulnerability requiring strict allowlisting.

---

#### BUG-04 · High · Insecure Direct Object Reference (IDOR) on Ticket Detail
- **Location:** `server/src/routes/tickets.js:31–41` · `server/src/services/ticketService.js:57–67`
- **Impact:** Cross-Tenant Confidentiality Breach
- **Affected Endpoint:** `GET /api/tickets/:id`

The service function `getTicketById(id)` queries solely by primary key (`WHERE t.id = ?`), omitting any organization filter. The route handler returned the result directly without comparing the ticket's `org_id` against `req.user.orgId`:
- **Business Impact:** The assignment states that Northwind Trading and Cobalt Logistics are separate customers who must never see each other's data. With sequential integer IDs, a Cobalt requester or agent can enumerate and inspect every confidential Northwind ticket by changing the URL parameter.
- **Remediation Strategy:** The route must enforce `ticket.org_id === req.user.orgId`. On mismatch, the API must return `404 Not Found` (rather than `403 Forbidden`) to avoid confirming the existence of resources belonging to another organization.

---

#### BUG-05 · High · Missing Role Guard & Tenant Check on Ticket Deletion
- **Location:** `server/src/routes/tickets.js:75–84`
- **Impact:** Unauthorized Cross-Tenant Data Destruction
- **Affected Endpoint:** `DELETE /api/tickets/:id`

The endpoint was guarded only by `requireAuth`. Although documented in the README as "Admin only", the `requireRole('admin')` middleware was completely absent, and no organization check was performed:
- **Business Impact:** Any authenticated user from any organization—including a standard `requester` from Cobalt—could execute `DELETE /api/tickets/:id` against any Northwind ticket. This represents a compound failure of both Role-Based Access Control (RBAC) and Multi-Tenant Isolation.

---

#### BUG-07 · High · Missing Role Guard & Tenant Check on Ticket Assignment
- **Location:** `server/src/routes/tickets.js:62–73`
- **Impact:** Unauthorized Privilege Escalation & Cross-Tenant State Modification
- **Affected Endpoint:** `PATCH /api/tickets/:id/assign`

The assign endpoint is intended exclusively for support personnel (`agent` or `admin`) to claim tickets within their organization. However:
- The route lacked `requireRole('agent', 'admin')`, allowing requesters to self-assign tickets.
- The route lacked an `org_id` check, allowing a Cobalt requester or agent to reassign Northwind tickets to themselves.
- This is a direct server-side authorization bypass, and its UI manifestation is BUG-10.

---

#### BUG-06 · High · Stored XSS in Comment Renderer
- **Location:** `client/src/features/tickets/TicketDetail.jsx:65`
- **Impact:** Arbitrary JavaScript Execution in Admin/Agent Browsers

```jsx
<div dangerouslySetInnerHTML={{ __html: c.body }} />
```

Ticket comments are submitted from a standard text `<textarea>`. There is no markdown parsing or rich-text pipeline. An authenticated attacker who posts a malicious HTML/script payload in a comment will trigger execution in the browser of any user (including support agents and admins) viewing that ticket.

---

#### BUG-08 · Medium · Pagination Offset Calculation Off-by-One
- **Location:** `server/src/services/ticketService.js:29`
- **Impact:** Functional Defect — First Page (Rows 1–20) Completely Inaccessible

```javascript
const offset = page * PAGE_SIZE; // On page=1, offset is 20
```

When `page = 1`, the offset is calculated as `20`, immediately skipping the first 20 records and displaying rows 21–40. The true first page of data can never be viewed. The correct mathematical offset is `(page - 1) * PAGE_SIZE`.

---

#### BUG-09 · Medium · TicketList Missing Filter State in Dependency Array
- **Location:** `client/src/features/tickets/TicketList.jsx:31`
- **Impact:** Functional Defect — Filter & Sort Dropdowns Do Not Re-Fetch Data

```javascript
useEffect(() => { ... }, [page]); // Missing search, status, priority, sortBy
```

While filter and sort values are updated in local React state and synchronized with URL search params, the fetching `useEffect` only tracks `[page]`. Interacting with the UI dropdowns produces no network request and does not refresh the ticket grid.

---

#### BUG-15 · Medium · Hard-Coded JWT Secret Fallback
- **Location:** `server/src/config.js:16`
- **Impact:** Authentication Bypass via Token Forgery if Environment Variable is Omitted

```javascript
jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
```

If `JWT_SECRET` is absent from `.env`, the server silently falls back to a publicly known hardcoded string. An attacker aware of this fallback can forge administrative JWTs without credentials. The service should fail fast during initialization if vital security secrets are missing.

---

#### BUG-11 · Medium · `server/.env` Not Excluded by `.gitignore`
- **Location:** `.gitignore`
- **Impact:** Sensitive Secrets (DB password, JWT secret) Committed to Source Control

The starter `.gitignore` failed to list `server/.env`. In collaborative or public repositories, committing `.env` exposes database credentials and cryptographic signing keys.

---

#### BUG-12 · Low · Permissive Wildcard CORS
- **Location:** `server/src/index.js:9`
- **Impact:** Cross-Origin API Access Permitted from Any Domain

`app.use(cors())` with default options enables `Access-Control-Allow-Origin: *`. In production, CORS should be strictly locked to trusted application domains.

---

#### BUG-13 · Low · N+1 Comment Count Database Queries
- **Location:** `server/src/services/ticketService.js:44–47`
- **Impact:** Database Overhead & Suboptimal Latency

For every ticket retrieved on a page of 20, a separate `SELECT COUNT(*)` query is dispatched in a loop (resulting in 21 queries per request). This should be consolidated into a single `LEFT JOIN ... GROUP BY` query.

---

#### BUG-14 · Low · Development Credentials Pre-Filled in Login Form
- **Location:** `client/src/features/auth/Login.jsx:10–11`
- **Impact:** Development Convenience Artifact

The login component initializes React state with `'agent1@northwind.test'` and `'Password123!'`. While helpful for local demos, credentials should never be pre-populated in production code.

---

## Section 2 — Fixes Applied

Exactly five targeted fixes were implemented. Each fix was committed on a dedicated Git branch, strictly within existing project patterns, and merged into `main` via separate pull requests.

### Git Verification Summary

| Fix | Vulnerability | Branch Name | Commit SHA | PR # | File Modified |
|:---:|:---|:---|:---:|:---:|:---|
| **Fix 1** | BUG-01+02 (Auth Bypass) | `fix/part-001-invite-accept-hash-and-auth` | `63223b1` | PR #2 | `server/src/routes/auth.js` |
| **Fix 2** | BUG-03 (SQL Injection) | `fix/part-002-sql-injection-sort-allowlist` | `6a73856` | PR #3 | `server/src/services/ticketService.js` |
| **Fix 3** | BUG-04 (Ticket Detail IDOR) | `fix/part-003-idor-ticket-detail-org-check` | `8ec0197` | PR #4 | `server/src/routes/tickets.js` |
| **Fix 4** | BUG-05 (Delete Auth & Org) | `fix/part-004-delete-auth-role-and-org` | `fed808e` | PR #5 | `server/src/routes/tickets.js` |
| **Fix 5** | BUG-07 (Assign Auth & Org) | `fix/part-005-assign-role-and-org` | `a988888` | PR #6 | `server/src/routes/tickets.js` |

---

### Fix 1 — Secure `/invite/accept`: Verify Token & Bcrypt-Hash Password
- **Branch:** `fix/part-001-invite-accept-hash-and-auth`
- **Commit ID:** `63223b1` (`fix: part-001-invite-accept-hash-and-auth`)
- **PR:** #2 (Merge commit: `9e08506`)
- **Target File:** `server/src/routes/auth.js`

#### Root Cause
The endpoint trusted a raw integer `userId` from the unauthenticated client body and wrote the raw plaintext password string directly into `password_hash`.

#### Implementation
```javascript
// Verification & Secure Hashing:
const { token, password } = req.body;
if (!token || !password || password.length < 8) {
  return res.status(400).json({ error: 'Valid token and password (min 8 chars) required' });
}

let decoded;
try {
  decoded = jwt.verify(token, config.jwtSecret);
} catch {
  return res.status(401).json({ error: 'Invalid or expired invite token' });
}

const passwordHash = await bcrypt.hash(password, 12);
await query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, decoded.sub]);
```

#### Rationale
- Extracts `userId` securely from `decoded.sub` within a cryptographically signed JWT, making account takeover impossible.
- Hashes passwords using `bcrypt.hash` with a work factor of 12, allowing `bcrypt.compare` to succeed during subsequent login.
- Enforces an 8-character minimum password length.
- Requires no database schema migrations.

---

### Fix 2 — Strict Allowlist for `sortBy` and `order` Parameters
- **Branch:** `fix/part-002-sql-injection-sort-allowlist`
- **Commit ID:** `6a73856` (`fix: allowlist sortBy and order params to prevent SQL injection`)
- **PR:** #3 (Merge commit: `d84a476`)
- **Target File:** `server/src/services/ticketService.js`

#### Root Cause
`sortBy` and `order` query parameters were interpolated directly into the SQL string via template literals.

#### Implementation
```javascript
const ALLOWED_SORT = new Set(['id', 'title', 'status', 'priority', 'created_at']);
const ALLOWED_ORDER = new Set(['asc', 'desc']);

// Sanitization with safe fallback defaults:
const safeSortBy = ALLOWED_SORT.has(sortBy) ? sortBy : 'created_at';
const safeOrder = ALLOWED_ORDER.has(String(order).toLowerCase()) ? order.toUpperCase() : 'DESC';

const sql = `SELECT ... ORDER BY t.${safeSortBy} ${safeOrder} ...`;
```

#### Rationale
- Because SQL column identifiers and `ASC`/`DESC` keywords cannot be parameterized with `?` prepared statement markers, a strict server-side allowlist is the industry-standard remediation.
- Completely prevents injection of arbitrary tokens, functions, or subqueries while preserving full legitimate sorting functionality.

---

### Fix 3 — Tenant Isolation Guard on `GET /tickets/:id` (IDOR Prevention)
- **Branch:** `fix/part-003-idor-ticket-detail-org-check`
- **Commit ID:** `8ec0197` (`fix: added org_id check to GET /tickets/:id to prevent IDOR`)
- **PR:** #4 (Merge commit: `09f1b42`)
- **Target File:** `server/src/routes/tickets.js`

#### Root Cause
The route fetched tickets by primary key and returned them without checking if `ticket.org_id` matched `req.user.orgId`.

#### Implementation
```javascript
const ticket = await ticketService.getTicketById(req.params.id);
if (!ticket || ticket.org_id !== req.user.orgId) {
  return res.status(404).json({ error: 'Ticket not found' });
}
```

#### Rationale
- Restricts ticket detail access strictly to users belonging to the owning organization.
- Responds with `404 Not Found` instead of `403 Forbidden` to avoid leaking the existence of tickets belonging to other tenants.
- Placed in the route layer to maintain consistency with the existing authorization architecture.

---

### Fix 4 — Role Guard & Organization Check on `DELETE /tickets/:id`
- **Branch:** `fix/part-004-delete-auth-role-and-org`
- **Commit ID:** `fed808e` (`fix: add requireRole(admin) and org check to DELETE /tickets/:id`)
- **PR:** #5 (Merge commit: `45fceab`)
- **Target File:** `server/src/routes/tickets.js`

#### Root Cause
The endpoint lacked both the administrative role requirement and an organization boundary check.

#### Implementation
```javascript
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const ticket = await ticketService.getTicketById(req.params.id);
  if (!ticket || ticket.org_id !== req.user.orgId) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  await ticketService.deleteTicket(req.params.id);
  res.status(204).send();
});
```

#### Rationale
- Attaches `requireRole('admin')` middleware using the existing application authorization helper.
- Enforces tenant isolation so even an administrator cannot delete tickets belonging to another organization.
- Prevents cross-tenant destructive actions.

---

### Fix 5 — Role Guard & Organization Check on `PATCH /tickets/:id/assign`
- **Branch:** `fix/part-005-assign-role-and-org`
- **Commit ID:** `a988888` (`fix: add requireRole(agent,admin) and org check to PATCH /tickets/:id/assign`)
- **PR:** #6 (Merge commit: `b5d817d`)
- **Target File:** `server/src/routes/tickets.js`

#### Root Cause
Any authenticated user (including `requester`) could claim any ticket from any organization.

#### Implementation
```javascript
router.patch('/:id/assign', requireAuth, requireRole('agent', 'admin'), async (req, res) => {
  const ticket = await ticketService.getTicketById(req.params.id);
  if (!ticket || ticket.org_id !== req.user.orgId) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  const updated = await ticketService.assignTicket(req.params.id, req.user.id);
  res.json(updated);
});
```

#### Rationale
- Restricts ticket assignment to `agent` and `admin` roles, neutralizing the server vulnerability that manifested in the UI as BUG-10.
- Guarantees that support personnel can only claim tickets originating within their own organization.

---

## Section 3 — What Was Not Fixed (and Technical Rationale)

The assignment explicitly limits Part 1 remediation to **the top five issues only**, leaving the rest documented with technical reasoning.

| Rank | ID | Finding | Technical Rationale for Deferral |
|:---:|:---|:---|:---|
| 6 | BUG-06 | Stored XSS via `dangerouslySetInnerHTML` | **Prioritization Trade-Off:** While severe, exploiting Stored XSS requires an authenticated user with comment posting privileges. The available five fix slots were prioritized for unauthenticated account takeover (BUG-01+02), arbitrary query manipulation (BUG-03), and direct cross-tenant data access/destruction (BUG-04, BUG-05, BUG-07). |
| 7 | BUG-08 | Pagination Offset Off-by-One | **Functional vs. Security:** A straightforward one-line arithmetic bug (`(page - 1) * PAGE_SIZE`). While noticeable to end users, it presents zero risk to data security, integrity, or tenant isolation and was correctly deprioritized below critical authorization flaws. |
| 8 | BUG-09 | `TicketList` `useEffect` Dependencies | **Scope Isolation:** This is a frontend reactivity bug with no security implications. To maintain clean, atomic commits, modifications to `TicketList.jsx` were deferred to Part 2 where list fetching and SLA filtering are natively extended. |
| 9 | BUG-15 | Hard-Coded JWT Secret Fallback | **Startup Behavior Dependency:** Replacing the fallback with a fail-fast startup check (`if (!process.env.JWT_SECRET) process.exit(1)`) alters process initialization across environments. Because the existing seed environment provides a valid secret in `.env`, immediate runtime risk in local testing is low. |
| 10 | BUG-11 | `server/.env` Not in `.gitignore` | **Repository Hygiene:** Resolved immediately in `.gitignore` as standard repository cleanliness, but deliberately excluded from the five application code fix slots. |
| 11 | BUG-12 | Permissive Wildcard CORS | **Environment Risk:** An internal support helpdesk application running in local docker/proxied environments is not actively threatened by wildcard origins at this stage. Requires origin whitelist in production deployment. |
| 12 | BUG-13 | N+1 Comment Count Queries | **Performance Concern:** Involves database query consolidation (`GROUP BY`). Does not affect correctness, authentication, or authorization. |
| 13 | BUG-14 | Login Pre-Filled Credentials | **Development Artifact:** Harmless convenience feature for evaluation demonstration; trivial to remove before staging deployment. |

---

## Section 4 — Reviewer Verification Instructions

Reviewers can verify the five atomic fixes and Git history using standard Git commands:

```bash
# 1. Inspect the clean branch and PR merge graph:
git log --graph --oneline --all -n 15

# 2. Inspect individual fix diffs:
git show 63223b1   # Fix 1: Auth token & bcrypt
git show 6a73856   # Fix 2: SQL allowlist
git show 8ec0197   # Fix 3: Ticket detail IDOR
git show fed808e   # Fix 4: Delete admin role & org check
git show a988888   # Fix 5: Assign role & org check

# 3. Test verification against clean seed data:
npm run db:reset
```
