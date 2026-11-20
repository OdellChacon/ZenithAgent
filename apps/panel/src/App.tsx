import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { alertHandoff, setUnseen } from './alerts';
import { Login } from './Login';
import { Inbox } from './Inbox';
import { Conversation } from './Conversation';
import { Header } from './Header';

/** Rutas: /, /conversaciones/:id. Sin dependencias de router. */
function parsePath(path: string): string | null {
  const m = /^\/conversaciones\/([0-9a-f-]{36})\/?$/i.exec(path);
  return m ? m[1]! : null;
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(() => parsePath(location.pathname));
  // Cada evento en vivo sube este contador y las vistas vuelven a pedir sus datos.
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else setMe(null);
    }
  }, []);

  useEffect(() => void loadMe(), [loadMe]);

  const open = useCallback((id: string | null) => {
    setSelected(id);
    history.pushState(null, '', id ? `/conversaciones/${id}` : '/');
    setUnseen(0);
  }, []);

  useEffect(() => {
    const onPop = () => setSelected(parsePath(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Eventos en vivo del negocio: nuevos mensajes, derivaciones y cambios de estado.
  useEffect(() => {
    if (!me) return;
    const source = new EventSource('/api/v1/events');
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = (e) => {
      let event: { type: string; conversationId: string };
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      setTick((t) => t + 1);
      if (event.type === 'handoff.requested') alertHandoff(() => open(event.conversationId));
    };
    return () => source.close();
  }, [me, open]);

  useEffect(() => {
    const onFocus = () => setUnseen(0);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (me === undefined) return <div className="center muted">Cargando…</div>;
  if (me === null) return <Login onLogin={loadMe} />;

  const logout = async () => {
    await api.logout().catch(() => undefined);
    setMe(null);
  };

  return (
    <div className="app">
      <Header me={me} live={live} onLogout={logout} />
      <div className={`workspace ${selected ? 'has-selection' : ''}`}>
        <Inbox me={me} tick={tick} selected={selected} onSelect={open} />
        {selected ? (
          <Conversation key={selected} id={selected} me={me} tick={tick} onClose={() => open(null)} onChanged={() => setTick((t) => t + 1)} />
        ) : (
          <div className="empty-pane">
            <p>Elige una conversación de la bandeja.</p>
            <p className="muted">Las derivadas por el bot aparecen en “Pendientes” y te avisamos con un sonido.</p>
          </div>
        )}
      </div>
    </div>
  );
}
