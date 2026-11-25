/** Piezas visuales compartidas: avatares, insignias de canal e íconos (SVG en línea, sin dependencias). */
import type { CSSProperties, ReactNode } from 'react';

export type ChannelId = 'whatsapp' | 'facebook' | 'messenger' | 'instagram' | 'tiktok';

/** Matiz estable por nombre, para que cada cliente tenga siempre el mismo color. */
function hue(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0]![0] ?? '') + (parts.length > 1 ? (parts.at(-1)![0] ?? '') : '')).toUpperCase();
}

export function Avatar({ name, channel, waiting, size }: { name: string; channel?: string; waiting?: boolean; size?: 'sm' }) {
  return (
    <span
      className={`avatar ${size ?? ''} ${waiting ? 'waiting' : ''}`}
      style={{ '--h': hue(name) } as CSSProperties}
      aria-hidden="true"
    >
      {initials(name)}
      {channel && <ChannelBadge channel={channel} />}
    </span>
  );
}

const GLYPHS: Record<ChannelId, ReactNode> = {
  // Burbuja de chat con auricular, genérica.
  whatsapp: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2.5a9.5 9.5 0 0 0-8.2 14.3L2.6 21.4l4.7-1.2A9.5 9.5 0 1 0 12 2.5Zm4.6 13.1c-.2.6-1.2 1.1-1.7 1.2-.4.1-1 .1-1.6-.1a12 12 0 0 1-5.6-4.9c-.5-.8-.9-1.7-.9-2.6 0-1 .5-1.5.8-1.8.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 1.9c.1.2.1.4 0 .6l-.4.6-.4.4c-.1.1-.3.3-.1.6.4.6.9 1.2 1.4 1.7.6.5 1.3.9 2 1.2.3.1.4.1.6-.1l.8-1c.2-.3.4-.2.6-.1l1.8.9c.3.1.4.2.5.3.1.2.1.8-.1 1.4Z" />
    </svg>
  ),
  facebook: <b>f</b>,
  messenger: <b>m</b>,
  instagram: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.3" cy="6.7" r=".6" fill="currentColor" />
    </svg>
  ),
  tiktok: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M14.5 3h3c.2 1.8 1.4 3.3 3.2 3.6v3a7 7 0 0 1-3.2-1v6.2A5.8 5.8 0 1 1 11.7 9v3.1a2.8 2.8 0 1 0 2.8 2.8V3Z" />
    </svg>
  ),
};

export function ChannelBadge({ channel, large }: { channel: string; large?: boolean }) {
  const id = (channel in GLYPHS ? channel : 'whatsapp') as ChannelId;
  return (
    <span className={`ch-badge ${id} ${large ? 'lg' : ''}`} aria-hidden="true">
      {GLYPHS[id]}
    </span>
  );
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const Icon = {
  send: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  ),
  soundOn: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" />
      <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  ),
  soundOff: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" />
      <path d="M16.5 9.5l5 5M21.5 9.5l-5 5" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
  ),
  logout: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  back: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M15 6l-6 6 6 6" />
    </svg>
  ),
  chats: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M20 11.5a7.5 7.5 0 0 1-11 6.6L4 19.5l1.4-4.6A7.5 7.5 0 1 1 20 11.5Z" />
      <path d="M8.5 10.5h7M8.5 13.5h4" />
    </svg>
  ),
  contacts: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 19.5a6.5 6.5 0 0 1 13 0M16 5.5a3.5 3.5 0 0 1 0 6.5M18 13.5a6 6 0 0 1 3.5 6" />
    </svg>
  ),
};

/** Doble check de entrega estilo WhatsApp. */
export function Ticks({ state }: { state: string | null }) {
  if (!state || state === 'queued' || state === 'sending') {
    return (
      <svg className="ticks" viewBox="0 0 16 16" {...stroke} strokeWidth={1.5}>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3l2 1.5" />
      </svg>
    );
  }
  if (state === 'failed' || state === 'blocked_window') {
    return (
      <svg className="ticks failed" viewBox="0 0 16 16" {...stroke} strokeWidth={1.6}>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.8v3.8M8 11h.01" />
      </svg>
    );
  }
  const double = state === 'delivered' || state === 'read';
  return (
    <svg className={`ticks ${state === 'read' ? 'read' : ''}`} viewBox="0 0 16 16" {...stroke} strokeWidth={1.6}>
      <path d={double ? 'M1.5 8.5l3 3 6-7' : 'M3.5 8.5l3 3 6-7'} />
      {double && <path d="M7.5 11.5l.2.1 6-7.1" />}
    </svg>
  );
}
