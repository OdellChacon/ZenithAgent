import type { Channel } from './types.js';

const MB = 1024 * 1024;

/**
 * Peso máximo para mandar un catálogo por un canal, según Meta: WhatsApp acepta documentos de
 * hasta 100 MB, fotos de 5 MB y videos de 16 MB; Messenger e Instagram, fotos de 8 MB y el resto
 * hasta 25 MB. null si el canal no admite ese tipo. Lo usan el panel (asesores) y el bot.
 */
export function catalogSendLimit(channel: Channel, mediaType: 'image' | 'video' | 'document', mimeType: string): number | null {
  if (channel === 'whatsapp') return mediaType === 'image' ? 5 * MB : mediaType === 'video' ? 16 * MB : 100 * MB;
  if (channel === 'messenger' || channel === 'instagram') {
    if (mediaType === 'image') return 8 * MB;
    if (mediaType === 'video' && mimeType !== 'video/mp4') return null;
    return 25 * MB;
  }
  return null;
}
