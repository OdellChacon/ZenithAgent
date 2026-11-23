/**
 * Motivos por los que Meta desconecta un número de la API (account_update), explicados para
 * el negocio. Los usan el correo de aviso y el panel.
 */
export const DISCONNECT_REASON_LABELS: Record<string, string> = {
  PRIMARY_INACTIVITY: 'El teléfono principal pasó unos 14 días sin abrir WhatsApp Business.',
  COMPANION_INACTIVITY: 'Un dispositivo vinculado pasó unos 30 días sin usarse.',
  ACCOUNT_DISCONNECTED: 'Alguien desconectó la cuenta desde la app de WhatsApp Business.',
  BUSINESS_DOWNGRADE: 'El número pasó de WhatsApp Business a WhatsApp normal.',
  CHANGE_NUMBER: 'Se cambió el número desde la app de WhatsApp Business.',
  USER_RE_REGISTERED: 'El número se volvió a registrar en WhatsApp.',
  ACCOUNT_OFFBOARDED: 'El número se registró en otro teléfono o se reinstaló WhatsApp Business.',
  ACCOUNT_DELETED: 'Se eliminó la cuenta de WhatsApp Business.',
  PARTNER_REMOVED: 'Se quitó el acceso del sistema a la cuenta de WhatsApp Business.',
};

export function disconnectReasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'Meta no indicó el motivo.';
  return DISCONNECT_REASON_LABELS[reason] ?? `Motivo informado por Meta: ${reason}.`;
}
