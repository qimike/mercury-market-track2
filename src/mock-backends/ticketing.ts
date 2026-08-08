/**
 * Mock ticketing system adapter (spec section 6/11). Represents the synthetic
 * web/mobile-chat support queue a human support agent works from; the
 * advisor is invoked against one ticket at a time. In-memory only — swap for
 * a real ticketing integration behind this same shape in a real deployment.
 */

import { ok, fail, type ToolResult } from "../domain/errors.js";

export interface SupportTicket {
  ticketId: string;
  customerId: string;
  channel: "web_chat" | "mobile_chat";
  subject: string;
  body: string;
  createdAt: string;
  status: "open" | "in_progress" | "resolved" | "closed";
}

const tickets = new Map<string, SupportTicket>();
let ticketSeq = 0;

export async function createTicket(input: {
  customerId: string;
  channel: SupportTicket["channel"];
  subject: string;
  body: string;
}): Promise<ToolResult<{ ticket: SupportTicket }>> {
  if (!input.customerId || !input.subject || !input.body) {
    return fail("VALIDATION", "MISSING_FIELDS", "customerId, subject, and body are required to open a ticket.", false);
  }
  ticketSeq += 1;
  const ticket: SupportTicket = {
    ticketId: `tick_${String(ticketSeq).padStart(4, "0")}`,
    customerId: input.customerId,
    channel: input.channel,
    subject: input.subject,
    body: input.body,
    createdAt: new Date().toISOString(),
    status: "open",
  };
  tickets.set(ticket.ticketId, ticket);
  return ok({ ticket });
}

export async function getTicket(ticketId: string): Promise<ToolResult<{ ticket: SupportTicket }>> {
  const ticket = tickets.get(ticketId);
  if (!ticket) {
    return fail("NOT_FOUND", "TICKET_NOT_FOUND", `No ticket found with id "${ticketId}".`, false);
  }
  return ok({ ticket });
}

export function setTicketStatus(ticketId: string, status: SupportTicket["status"]): void {
  const ticket = tickets.get(ticketId);
  if (ticket) ticket.status = status;
}

export function listTickets(): SupportTicket[] {
  return [...tickets.values()];
}

export function _resetTicketingMockState(): void {
  tickets.clear();
  ticketSeq = 0;
}
