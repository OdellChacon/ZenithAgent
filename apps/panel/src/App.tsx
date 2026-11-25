import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, ApiError, type Me } from './api';
import { alertHandoff, setUnseen } from './alerts';
import { Login } from './Login';
import { Inbox } from './Inbox';
import { Conversation } from './Conversation';
import { Contacts } from './Contacts';
import { Header, SECTION_PATHS, type Section } from './Header';
import { ChannelAlerts } from './ChannelAlerts';
import { Channels } from './Channels';
import { ComingSoon } from './ComingSoon';
import { unlockAudioOnGesture } from './sounds';
import { Icon } from './ui';

interface Route {
  section: Section;
  id: string | null;
}

/** Rutas: /, /conversaciones/:id, /contactos, /contactos/:id. Sin dependencias de router. */
function parsePath(path: string): Route {
  const conv = /^\/conversaciones\/([0-9a-f-]{36})\/?$/i.exec(path);
  if (conv) return { section: 'inbox', id: conv[1]! };
  const contact = /^\/contactos(?:\/([0-9a-f-]{36}))?\/?$/i.exec(path);
  if (contact) return { section: 'contacts', id: contact[1] ?? null };
  if (/^\/whatsapp\/?$/i.test(path)) return { section: 'channels', id: null };
  const soon = /^\/(facebook|instagram|tiktok)\/?$/i.exec(path);
  if (soon) return { section: soon[1]!.toLowerCase() as Section, id: null };
  return { section: 'inbox', id: null };
}

function toPath(route: Route): string {
  if (route.section === 'contacts') return route.id ? `/contactos/${route.id}` : '/contactos';
  if (route.section === 'inbox') return route.id ? `/conversaciones/${route.id}` : '/';
  return SECTION_PATHS[route.section];
}

/** Cambia de vista con la View Transitions API cuando el navegador la tiene. */
function withTransition(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(() => flushSync(update));
  else update();
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [route, setRoute] = useState<Route>(() => parsePath(location.pathname));
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

  const go = useCallback((next: Route) => {
    const sectionChanged = next.section !== routeRef.current.section;
    const apply = () => setRoute(next);
    if (sectionChanged) withTransition(apply);
    else apply();
    history.pushState(null, '', toPath(next));
    setUnseen(0);
  }, []);
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => unlockAudioOnGesture(), []);
  const open = useCallback((id: string | null) => go({ section: 'inbox', id }), [go]);

  useEffect(() => {
    const onPop = () => setRoute(parsePath(location.pathname));
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

  const selected = route.id;

  return (
    <div className="app">
      <Header me={me} live={live} section={route.section} onNavigate={(section) => go({ section, id: null })} onLogout={logout} />
      <ChannelAlerts tick={tick} />
      {route.section === 'facebook' || route.section === 'instagram' || route.section === 'tiktok' ? (
        <ComingSoon key={route.section} which={route.section} />
      ) : route.section === 'channels' ? (
        <Channels tick={tick} />
      ) : route.section === 'contacts' ? (
        <Contacts tick={tick} selected={selected} onSelect={(id) => go({ section: 'contacts', id })} onOpenConversation={open} />
      ) : (
        <div className={`workspace ${selected ? 'has-selection' : ''}`}>
          <Inbox me={me} tick={tick} selected={selected} onSelect={open} />
          {selected ? (
            <Conversation
              key={selected}
              id={selected}
              me={me}
              tick={tick}
              onClose={() => open(null)}
              onChanged={() => setTick((t) => t + 1)}
              onOpenContact={(id) => go({ section: 'contacts', id })}
            />
          ) : (
            <div className="empty-pane">
              <span className="empty-art" aria-hidden="true">{Icon.chats}</span>
              <p>Elige una conversación de la bandeja.</p>
              <p className="muted">Las derivadas por el bot aparecen en “Pendientes” y te avisamos con un sonido.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
