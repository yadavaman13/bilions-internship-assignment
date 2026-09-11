import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  listTickets,
  getTicketById,
  createTicket,
  assignTicket,
  deleteTicket,
  listComments,
} from '../services/ticketService.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = await listTickets({
      orgId: req.user.orgId,
      page: Number(req.query.page || 1),
      search: req.query.search || '',
      status: req.query.status,
      priority: req.query.priority,
      sortBy: req.query.sortBy || 'created_at',
      order: req.query.order || 'desc',
      slaState: req.query.slaState || '',
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const ticket = await getTicketById(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    // Fix: BUG-04 — previously any authenticated user could read any ticket by id.
    // Return 404, so we don't leak that the ticket exists at another org.
    if (ticket.org_id !== req.user.orgId) return res.status(404).json({ error: 'Not found' });

    const comments = await listComments(ticket.id);
    res.json({ ticket, comments });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { subject, body, priority } = req.body;
    if (!subject || !body) {
      return res.status(400).json({ error: 'subject and body are required' });
    }
    const ticket = await createTicket({
      orgId: req.user.orgId,
      subject,
      body,
      priority: priority || 'P3',
      requesterId: req.user.id,
    });
    res.status(201).json(ticket);
  } catch (err) {
    next(err);
  }
});

// Fix: BUG-07 — previously only requireAuth guarded this route; added role check
router.patch('/:id/assign', requireAuth, requireRole('agent', 'admin'), async (req, res, next) => {
  try {
    const ticket = await getTicketById(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    // Org check: agents may only claim tickets belonging to their own organisation.
    if (ticket.org_id !== req.user.orgId) return res.status(404).json({ error: 'Not found' });
    const result = await assignTicket(Number(req.params.id), req.user.id);
    if (!result) return res.status(404).json({ error: 'Not found' });
    if (result.conflict) {
      return res.status(409).json({ error: 'Ticket already assigned', ticket: result.ticket });
    }
    res.json(result.ticket);
  } catch (err) {
    next(err);
  }
});

// Fix: BUG-05 — previously only requireAuth guarded this route 
// any authenticated user (including requesters) could delete any ticket from any organisation.
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const ticket = await getTicketById(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    // Org check: admin may only delete tickets belonging to their own organisation.
    if (ticket.org_id !== req.user.orgId) return res.status(404).json({ error: 'Not found' });
    await deleteTicket(ticket.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
