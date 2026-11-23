import { useState } from 'react';
import type { Me } from './api';
import { chime, enableNotifications, notificationsEnabled, notificationsSupported } from './alerts';

export type Section = 'inbox' | 'contacts';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'inbox', label: 'Conversaciones' },
  { id: 'contacts', label: 'Contactos' },
];

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
  const [notify, setNotify] = useState(notificationsEnabled());
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden="true">Z</span>
        <div>
          <b>{me.tenant.name}</b>
          <span className="muted">Panel de asesores</span>
        </div>
      </div>
      <nav className="sections" aria-label="Secciones">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={s.id === 'contacts' ? '/contactos' : '/'}
            className={`section-link ${section === s.id ? 'on' : ''}`}
            aria-current={section === s.id ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              onNavigate(s.id);
            }}
          >
            {s.label}
          </a>
        ))}
      </nav>
      <div className="top-actions">
        <span className={`live ${live ? 'on' : ''}`} title={live ? 'Recibiendo avisos en vivo' : 'Reconectando…'}>
          <i aria-hidden="true" /> {live ? 'En vivo' : 'Reconectando'}
        </span>
        {notificationsSupported() && !notify && (
          <button
            className="btn ghost"
            type="button"
            onClick={async () => {
              setNotify(await enableNotifications());
              chime();
            }}
          >
            Activar avisos
          </button>
        )}
        <span className="user" title={me.email}>
          {me.name}
        </span>
        <button className="btn ghost" type="button" onClick={onLogout}>
          Salir
        </button>
      </div>
    </header>
  );
}
