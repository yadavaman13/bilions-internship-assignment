import { query } from '../db/pool.js';
import { computeSla } from './slaService.js';

const PAGE_SIZE = 20;

// Fix: BUG-03 — sortBy and order were interpolated directly into SQL from req.query.
// Allowlist both values; unrecognised input falls back to a safe default.
const ALLOWED_SORT  = new Set(['created_at', 'updated_at', 'priority', 'status', 'subject']);
const ALLOWED_ORDER = new Set(['asc', 'desc']);
const ALLOWED_SLA_STATES = new Set(['WITHIN_SLA', 'MET', 'BREACHED']);

// Correlated subquery for earliest support response (role agent or admin)
const FIRST_RESPONSE_SQL = `(
  SELECT MIN(c.created_at)
    FROM comments c
    JOIN users u ON u.id = c.author_id
   WHERE c.ticket_id = t.id
     AND u.role IN ('agent', 'admin')
)`;

// SLA deadline computed from ticket created_at and priority target (P1: 4h, P2: 24h, P3: 72h)
const SLA_DEADLINE_SQL = `DATE_ADD(
  t.created_at,
  INTERVAL (
    CASE t.priority
      WHEN 'P1' THEN 4
      WHEN 'P2' THEN 24
      WHEN 'P3' THEN 72
      ELSE 72
    END
  ) HOUR
)`;

// Evaluates ticket SLA state directly in MySQL:
// - MET: first support response was at or before deadline
// - WITHIN_SLA: no response yet, deadline has not passed
// - BREACHED: response arrived after deadline OR deadline passed without response
const SLA_STATE_SQL = `(
  CASE
    WHEN ${FIRST_RESPONSE_SQL} IS NOT NULL THEN (
      CASE WHEN ${FIRST_RESPONSE_SQL} <= ${SLA_DEADLINE_SQL} THEN 'MET' ELSE 'BREACHED' END
    )
    ELSE (
      CASE WHEN NOW() <= ${SLA_DEADLINE_SQL} THEN 'WITHIN_SLA' ELSE 'BREACHED' END
    )
  END
)`;

/**
 * Paginated ticket list for the current organisation.
 *
 * Supports free-text search on subject, filtering by status and priority,
 * sorting by allowed columns, and database-level SLA state filtering.
 *
 * All filtering, counting, and pagination occur directly in SQL so memory
 * usage remains O(1) regardless of total ticket volume. Only the current
 * page (up to 20 rows) is enriched with full SLA objects.
 */
export async function listTickets({ orgId, page = 1, search = '', status, priority, sortBy = 'created_at', order = 'desc', slaState = '' }) {
  const safeSortBy = ALLOWED_SORT.has(sortBy)  ? sortBy : 'created_at';
  const safeOrder  = ALLOWED_ORDER.has(order)  ? order  : 'desc';
  const where = ['t.org_id = ?'];
  const params = [orgId];

  if (search) {
    where.push('t.subject LIKE ?');
    params.push(`%${search}%`);
  }
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }
  if (priority) {
    where.push('t.priority = ?');
    params.push(priority);
  }
  if (slaState && ALLOWED_SLA_STATES.has(slaState)) {
    where.push(`${SLA_STATE_SQL} = ?`);
    params.push(slaState);
  }

  const whereSql = where.join(' AND ');

  // Helper: attach SLA metadata to the current page rows using one batched first-response query.
  async function enrichWithSla(rows) {
    if (rows.length === 0) return rows;
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const firstResponses = await query(
      `SELECT c.ticket_id, MIN(c.created_at) AS first_responded_at
         FROM comments c
         JOIN users u ON u.id = c.author_id
        WHERE c.ticket_id IN (${placeholders})
          AND u.role IN ('agent', 'admin')
        GROUP BY c.ticket_id`,
      ids
    );
    const map = new Map(
      firstResponses.map((r) => [r.ticket_id, new Date(r.first_responded_at)])
    );
    return rows.map((row) => ({ ...row, sla: computeSla(row, map.get(row.id) ?? null) }));
  }

  // 1. Compute total matching tickets at DB level
  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM tickets t WHERE ${whereSql}`,
    params
  );

  // 2. Fetch only the requested page at DB level
  const offset = (page - 1) * PAGE_SIZE;
  let rows = await query(
    `SELECT t.id, t.subject, t.status, t.priority, t.created_at, t.updated_at,
            t.assignee_id, u.name AS assignee_name, r.name AS requester_name,
            (SELECT COUNT(*) FROM comments c WHERE c.ticket_id = t.id) AS comment_count
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
      WHERE ${whereSql}
      ORDER BY t.${safeSortBy} ${safeOrder}
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  // 3. Enrich only the 20 rows of the current page with full SLA details
  rows = await enrichWithSla(rows);

  return { rows, total: Number(total), page, pageSize: PAGE_SIZE };
}

/**
 * Fetch a single ticket by id and attach its SLA object.
 * The org check is done in the route — this function returns null if not found.
 */
export async function getTicketById(id) {
  const rows = await query(
    `SELECT t.*, u.name AS assignee_name, r.name AS requester_name, r.email AS requester_email
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
      WHERE t.id = ?`,
    [id]
  );
  if (!rows[0]) return null;

  // Attach SLA: find the first agent/admin comment for this ticket.
  const [firstResponse] = await query(
    `SELECT MIN(c.created_at) AS first_responded_at
       FROM comments c
       JOIN users u ON u.id = c.author_id
      WHERE c.ticket_id = ?
        AND u.role IN ('agent', 'admin')`,
    [id]
  );
  const firstRespondedAt = firstResponse?.first_responded_at
    ? new Date(firstResponse.first_responded_at)
    : null;

  return { ...rows[0], sla: computeSla(rows[0], firstRespondedAt) };
}

export async function listComments(ticketId) {
  return query(
    `SELECT c.id, c.body, c.is_internal, c.created_at, u.name AS author_name, u.role AS author_role
       FROM comments c
       JOIN users u ON u.id = c.author_id
      WHERE c.ticket_id = ?
      ORDER BY c.created_at ASC`,
    [ticketId]
  );
}

export async function createTicket({ orgId, subject, body, priority, requesterId }) {
  const result = await query(
    `INSERT INTO tickets (org_id, subject, body, priority, requester_id)
     VALUES (?, ?, ?, ?, ?)`,
    [orgId, subject, body, priority, requesterId]
  );
  return getTicketById(result.insertId);
}

export async function assignTicket(ticketId, assigneeId) {
  const ticket = await getTicketById(ticketId);
  if (!ticket) return null;

  if (ticket.assignee_id) {
    return { conflict: true, ticket };
  }

  // Look up the agent so the response carries a display name for the toast.
  const [agent] = await query('SELECT id, name FROM users WHERE id = ?', [assigneeId]);

  await query('UPDATE tickets SET assignee_id = ?, status = ? WHERE id = ?', [assigneeId, 'pending', ticketId]);
  return { conflict: false, assignedTo: agent, ticket: await getTicketById(ticketId) };
}

export async function deleteTicket(id) {
  await query('DELETE FROM tickets WHERE id = ?', [id]);
}
