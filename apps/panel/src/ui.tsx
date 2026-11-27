/**
 * Piezas visuales compartidas: avatares, insignias de canal e íconos.
 * Íconos de interfaz: Lucide. Logos de los canales: Simple Icons (trazos oficiales de cada marca).
 */
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowLeft, Bell, Check, CheckCheck, ChevronDown, CircleAlert, Clock3, FileText, LogOut, MessagesSquare, Moon, Paperclip, Search, X,
  SendHorizontal, Sun, Tags, Users, Volume2, VolumeX, type LucideIcon,
} from 'lucide-react';
import { siFacebook, siInstagram, siMessenger, siTiktok, siWhatsapp, type SimpleIcon } from 'simple-icons';

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

const BRANDS: Record<ChannelId, SimpleIcon> = {
  whatsapp: siWhatsapp,
  facebook: siFacebook,
  messenger: siMessenger,
  instagram: siInstagram,
  tiktok: siTiktok,
};

export function BrandGlyph({ channel }: { channel: string }) {
  const icon = BRANDS[(channel in BRANDS ? channel : 'whatsapp') as ChannelId];
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={icon.path} />
    </svg>
  );
}

export function ChannelBadge({ channel, large }: { channel: string; large?: boolean }) {
  const id = (channel in BRANDS ? channel : 'whatsapp') as ChannelId;
  return (
    <span className={`ch-badge ${id} ${large ? 'lg' : ''}`} aria-hidden="true">
      <BrandGlyph channel={id} />
    </span>
  );
}

const icon = (C: LucideIcon): ReactNode => <C strokeWidth={1.9} aria-hidden="true" />;

export const Icon = {
  send: icon(SendHorizontal),
  soundOn: icon(Volume2),
  soundOff: icon(VolumeX),
  bell: icon(Bell),
  logout: icon(LogOut),
  sun: icon(Sun),
  moon: icon(Moon),
  search: icon(Search),
  chevron: icon(ChevronDown),
  back: icon(ArrowLeft),
  chats: icon(MessagesSquare),
  contacts: icon(Users),
  tags: icon(Tags),
  clip: icon(Paperclip),
  file: icon(FileText),
  close: icon(X),
};

/** Estado de entrega estilo WhatsApp: reloj, un check, doble check (azul si se leyó) o alerta. */
export function Ticks({ state }: { state: string | null }) {
  if (!state || state === 'queued' || state === 'sending') return <Clock3 className="ticks" strokeWidth={2} aria-hidden="true" />;
  if (state === 'failed' || state === 'blocked_window') return <CircleAlert className="ticks failed" strokeWidth={2} aria-hidden="true" />;
  if (state === 'delivered' || state === 'read') return <CheckCheck className={`ticks ${state === 'read' ? 'read' : ''}`} strokeWidth={2.2} aria-hidden="true" />;
  return <Check className="ticks" strokeWidth={2.2} aria-hidden="true" />;
}
