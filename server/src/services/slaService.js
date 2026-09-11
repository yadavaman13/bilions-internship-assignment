import { config } from '../config.js';

/**
 * Compute the SLA object for a single ticket.
 *
 * SLA type: first-response SLA.
 * - Clock starts at ticket.created_at.
 * - Clock stops at the first comment authored by a user with role
 *   'agent' or 'admin'. Customer comments do not stop the clock.
 * - SLA is never satisfied by closing/resolving a ticket without a response.
 *
 * States:
 *   WITHIN_SLA   — no support response yet, deadline has not passed
 *   MET          — first support response was at or before the deadline
 *   BREACHED     — no response and deadline has passed,
 *                  OR first response arrived after the deadline
 */
export function computeSla(ticket, firstRespondedAt, now = new Date()) {
  const targetHours = config.slaTargets[ticket.priority];

  if (targetHours === undefined) {
    return {
      targetHours: null,
      deadline: null,
      state: 'UNKNOWN',
      breached: false,
      firstRespondedAt: firstRespondedAt ? firstRespondedAt.toISOString() : null,
    };
  }

  const deadline = new Date(
    new Date(ticket.created_at).getTime() + targetHours * 60 * 60 * 1000
  );

  if (firstRespondedAt) {
    // Response exists — breach is historical
    const breached = firstRespondedAt > deadline;
    return {
      targetHours,
      deadline: deadline.toISOString(),
      state: breached ? 'BREACHED' : 'MET',
      breached,
      firstRespondedAt: firstRespondedAt.toISOString(),
    };
  }

  const breached = now > deadline;
  return {
    targetHours,
    deadline: deadline.toISOString(),
    state: breached ? 'BREACHED' : 'WITHIN_SLA',
    breached,
    firstRespondedAt: null,
  };
}

