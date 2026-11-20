import { useState } from 'react';
import type { Me } from './api';
import { chime, enableNotifications, notificationsEnabled, notificationsSupported } from './alerts';

export function Header({ me, live, onLogout }: { me: Me; live: boolean; onLogout: () => void }) {
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
