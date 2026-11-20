import type { Channel } from '@zenith/core';

/**
 * Ajusta el texto del modelo al formato que entiende cada app. Los modelos suelen escribir
 * Markdown (**negrita**, # títulos, [texto](enlace)), que WhatsApp no interpreta y que
 * Instagram y Messenger muestran con los símbolos a la vista.
 */
export function formatForChannel(text: string, channel: Channel): string {
  let out = text
    .replace(/\r\n/g, '\n')
    // [texto](https://…) → texto: https://…
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label}: ${url}`))
    // Títulos de Markdown → línea en negrita.
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    // Viñetas con asterisco → guion, para no confundirlas con negrita.
    .replace(/^(\s*)\*\s+/gm, '$1- ');

  if (channel === 'whatsapp') {
    // WhatsApp: *negrita*, _cursiva_, ~tachado~.
    out = out
      .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
      .replace(/__([^_\n]+)__/g, '_$1_')
      .replace(/~~([^~\n]+)~~/g, '~$1~');
  } else {
    // Instagram, Messenger, TikTok: texto plano.
    out = out
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, '$1$2')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/~~([^~\n]+)~~/g, '$1');
  }

  return out.replace(/\n{3,}/g, '\n\n').trim();
}
