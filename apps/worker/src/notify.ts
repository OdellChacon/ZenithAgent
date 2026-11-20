import { withTenant, type Pool } from '@zenith/db';
import type { NotifyJobData } from '@zenith/core';

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const HANDOFF_REASON_LABELS: Record<string, string> = {
  precio: 'Pide precio o cotización',
  pedido_grande: 'Pedido grande',
  pago: 'Pregunta por formas de pago',
  queja: 'Queja o reclamo',
  pide_humano: 'Pidió hablar con una persona',
  fuera_de_alcance: 'Consulta que el bot no puede resolver',
  seguridad: 'El bot no pudo responder (filtro de seguridad)',
  error: 'El bot no pudo responder (falla técnica)',
  otro: 'Otro motivo',
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export type NotifyOutcome = { result: 'sent'; recipients: number } | { result: 'skipped'; reason: 'not_found' | 'already_taken' | 'no_recipients' };

/**
 * Avisa por correo a los asesores del negocio que hay un cliente derivado. El correo lleva
 * el nombre del cliente, el motivo, el resumen del bot y el enlace al panel; no lleva el
 * número de teléfono ni la conversación completa.
 */
export async function processNotifyJob(deps: { pool: Pool; mailer: Mailer; panelUrl: string }, job: NotifyJobData): Promise<NotifyOutcome> {
  const info = await withTenant(deps.pool, job.tenantId, async (client) => {
    const { rows } = await client.query<{ reason: string; summary: string | null; taken_at: Date | null; contact: string | null; tenant: string }>(
      `SELECT h.reason, h.summary, h.taken_at, ct.name AS contact, t.name AS tenant
         FROM handoffs h
         JOIN conversations c ON c.id = h.conversation_id
         JOIN contacts ct ON ct.id = c.contact_id
         JOIN tenants t ON t.id = h.tenant_id
        WHERE h.id = $1`,
      [job.handoffId],
    );
    return rows[0];
  });
  if (!info) return { result: 'skipped', reason: 'not_found' };
  if (info.taken_at) return { result: 'skipped', reason: 'already_taken' };

  const { rows: recipients } = await deps.pool.query<{ email: string }>(
    `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.notify_email AND u.status = 'active'`,
    [job.tenantId],
  );
  if (!recipients.length) return { result: 'skipped', reason: 'no_recipients' };

  const contact = info.contact?.trim() || 'Un cliente';
  const reason = HANDOFF_REASON_LABELS[info.reason] ?? info.reason;
  const link = new URL(`/conversaciones/${job.conversationId}`, deps.panelUrl).toString();
  const summary = info.summary?.trim() || 'Sin resumen.';

  await deps.mailer.send({
    to: recipients.map((r) => r.email),
    subject: `${contact} espera a un asesor · ${reason}`,
    text: `${contact} fue derivado a un asesor en ${info.tenant}.\n\nMotivo: ${reason}\nResumen del bot: ${summary}\n\nAtender: ${link}\n`,
    html:
      `<p><b>${escapeHtml(contact)}</b> fue derivado a un asesor en ${escapeHtml(info.tenant)}.</p>` +
      `<p><b>Motivo:</b> ${escapeHtml(reason)}<br><b>Resumen del bot:</b> ${escapeHtml(summary)}</p>` +
      `<p><a href="${escapeHtml(link)}">Abrir la conversación en el panel</a></p>`,
  });
  return { result: 'sent', recipients: recipients.length };
}
