import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Me } from './api';
import { chime, enableNotifications, notificationsEnabled, notificationsSupported } from './alerts';
import { isMuted, onMutedChange, playSound, setMuted } from './sounds';
import { currentTheme, setTheme, type Theme } from './theme';
import { Avatar, ChannelBadge, Icon } from './ui';
import { Brand } from './Brand';

export type Section = 'inbox' | 'contacts' | 'catalogs' | 'channels' | 'facebook' | 'instagram' | 'tiktok';

export const SECTION_PATHS: Record<Section, string> = {
  inbox: '/',
  contacts: '/contactos',
  catalogs: '/catalogos',
  channels: '/whatsapp',
  facebook: '/facebook',
  instagram: '/instagram',
  tiktok: '/tiktok',
};

const MAIN: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'inbox', label: 'Conversaciones', icon: Icon.chats },
  { id: 'contacts', label: 'Contactos', icon: Icon.contacts },
  { id: 'catalogs', label: 'Catálogos', icon: Icon.catalog },
];

const CHANNELS: { id: Section; label: string; channel: string; soon?: boolean }[] = [
  { id: 'channels', label: 'WhatsApp', channel: 'whatsapp' },
  { id: 'facebook', label: 'Facebook', channel: 'facebook', soon: true },
  { id: 'instagram', label: 'Instagram', channel: 'instagram', soon: true },
  { id: 'tiktok', label: 'TikTok', channel: 'tiktok', soon: true },
];

const ROLE_LABELS: Record<Me['role'], string> = { owner: 'Propietario', admin: 'Administrador', agent: 'Asesor' };

const spring = { type: 'spring', stiffness: 520, damping: 38 } as const;

function NavLink({
  id,
  active,
  onNavigate,
  title,
  children,
}: {
  id: Section;
  active: boolean;
  onNavigate: (s: Section) => void;
  /** Nombre completo: se ve como ayuda cuando la barra solo muestra el ícono. */
  title?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={SECTION_PATHS[id]}
      title={title}
      className={`section-link ${active ? 'on' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        if (!active) playSound('tap');
        onNavigate(id);
      }}
    >
      {active && <motion.i className="nav-pill" layoutId="nav-pill" transition={spring} />}
      <span>{children}</span>
    </a>
  );
}

function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(currentTheme);
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      role="switch"
      aria-checked={dark}
      aria-label={dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
      title={dark ? 'Modo claro' : 'Modo oscuro'}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        playSound('tap');
        setTheme(dark ? 'light' : 'dark', { x: r.left + r.width / 2, y: r.top + r.height / 2 }, () => setThemeState(dark ? 'light' : 'dark'));
      }}
    >
      <motion.span className="theme-knob" animate={{ x: dark ? 28 : 0 }} transition={spring} />
      <span className={dark ? '' : 'on'}>{Icon.sun}</span>
      <span className={dark ? 'on' : ''}>{Icon.moon}</span>
    </button>
  );
}

function UserMenu({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [muted, setMutedState] = useState(isMuted());
  const [notify, setNotify] = useState(notificationsEnabled());
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => onMutedChange(setMutedState), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="user-wrap" ref={wrap}>
      <button type="button" className="user-card" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <Avatar name={me.name} size="sm" />
          <i className="presence" aria-hidden="true" />
        </span>
        <span className="user-meta">
          <b>{me.name}</b>
          <small>{ROLE_LABELS[me.role]} · en línea</small>
        </span>
        <span className="chev">{Icon.chevron}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="menu"
            role="menu"
            initial={{ opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 500, damping: 32 }}
          >
            <div className="menu-head">
              <Avatar name={me.name} />
              <div style={{ minWidth: 0 }}>
                <b>{me.name}</b>
                <span className="email">{me.email}</span>
                <span className="role-badge">{ROLE_LABELS[me.role]}</span>
              </div>
            </div>
            <hr />
            <button
              type="button"
              className="menu-item"
              role="menuitemcheckbox"
              aria-checked={!muted}
              onClick={() => {
                setMuted(!muted);
                if (muted) playSound('success');
              }}
            >
              {muted ? Icon.soundOff : Icon.soundOn}
              <span className="grow">Sonidos de aviso</span>
              <span className={`switch ${muted ? '' : 'on'}`} aria-hidden="true" />
            </button>
            {notificationsSupported() && (
              <button
                type="button"
                className="menu-item"
                role="menuitemcheckbox"
                aria-checked={notify}
                disabled={notify}
                onClick={async () => {
                  setNotify(await enableNotifications());
                  chime();
                }}
              >
                {Icon.bell}
                <span className="grow">{notify ? 'Avisos del sistema activos' : 'Activar avisos del sistema'}</span>
                <span className={`switch ${notify ? 'on' : ''}`} aria-hidden="true" />
              </button>
            )}
            <hr />
            <button type="button" className="menu-item danger" role="menuitem" onClick={onLogout}>
              {Icon.logout}
              <span className="grow">Cerrar sesión</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Header({
  me,
  live,
  section,
  onNavigate,
  onLogout,
}: {
  me: Me;
  live: boolean;
  section: Section;
  onNavigate: (section: Section) => void;
  onLogout: () => void;
}) {
  return (
    <header className="topbar">
      <Brand tenantName={me.tenant.name} />
      <nav className="sections" aria-label="Secciones">
        {MAIN.map((s) => (
          <NavLink key={s.id} id={s.id} active={section === s.id} onNavigate={onNavigate}>
            <span className="nav-icon">{s.icon}</span>
            {s.label}
          </NavLink>
        ))}
        <span className="nav-sep" aria-hidden="true" />
        {CHANNELS.map((s) => (
          <NavLink key={s.id} id={s.id} active={section === s.id} onNavigate={onNavigate} title={s.soon ? `${s.label} (pronto)` : s.label}>
            <ChannelBadge channel={s.channel} />
            <span className="nav-label">{s.label}</span>
            {s.soon && <span className="soon-dot" title="En construcción">Pronto</span>}
          </NavLink>
        ))}
      </nav>
      <div className="top-actions">
        <span className={`live ${live ? 'on' : ''}`} title={live ? 'Recibiendo avisos en vivo' : 'Reconectando…'}>
          <i aria-hidden="true" /> <span className="live-label">{live ? 'En vivo' : 'Reconectando'}</span>
        </span>
        <ThemeToggle />
        <UserMenu me={me} onLogout={onLogout} />
      </div>
    </header>
  );
}
